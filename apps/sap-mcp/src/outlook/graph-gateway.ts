import { createHash } from 'node:crypto';
import { M, type Logger } from '@prowess/observability';
import { SapError, type SapCallContext } from '../sap/model.js';
import { MAX_ATTACHMENT_BYTES, type AttachmentContent, type AttendeeResponse, type CalendarEvent, type MailAddress, type MailGateway, type MailListQuery, type MailMessage, type MailSearch, type MailSummary, type NewMail } from './model.js';

/**
 * Outlook over Microsoft Graph v1.0, called as the signed-in user.
 *
 * Identity: users sign in through SAP Cloud Identity Services (IAS) with Entra ID as its OpenID Connect corporate
 * identity provider. IAS keeps the Entra tokens of that sign-in and, through `/oauth2/exchange/corporateidp`, hands
 * out a delegated Graph token for the user's IAS token. Every call is made on `/me`, so Exchange decides which
 * mailbox and calendar the user may open. Without an IAS token the call is refused; there is no technical user.
 */

type Fetch = typeof fetch;

export interface GraphTokenSource {
  /** A Graph access token for the user of the call. */
  tokenFor(ctx: SapCallContext): Promise<string>;
}

export interface IasGraphTokensConfig {
  /** Identity Authentication tenant, e.g. https://<tenant>.accounts.ondemand.com */
  iasUrl: string;
  /** The IAS application the users sign in to (the one the subaccount's XSUAA trusts). */
  clientId: string;
  clientSecret: string;
  /** Delegated Graph scopes requested from Entra through IAS. */
  scopes: string;
  logger: Logger;
}

export const GRAPH_SCOPES = ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read'].map((s) => `https://graph.microsoft.com/${s}`).join(' ');
const TOKEN_SKEW_MS = 60_000;
const TOKEN_CACHE_SIZE = 2_000;

/** Graph tokens from the IAS corporate IdP token exchange, cached per IAS token until shortly before they expire. */
export class IasGraphTokens implements GraphTokenSource {
  private readonly cache = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly cfg: IasGraphTokensConfig,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async tokenFor(ctx: SapCallContext): Promise<string> {
    if (!ctx.iasToken) {
      throw new SapError('NOT_AUTHORIZED', 'Outlook works through your Microsoft sign-in. Sign out of the workspace and sign in again to use it.');
    }
    const key = createHash('sha256').update(ctx.iasToken).digest('hex');
    const hit = this.cache.get(key);
    if (hit && hit.expires - TOKEN_SKEW_MS > Date.now()) return hit.token;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.iasUrl.replace(/\/+$/, '')}/oauth2/exchange/corporateidp`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ assertion: ctx.iasToken, response_type: 'token', scope: this.cfg.scopes }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.cfg.logger.warn('outlook.token_exchange_failed', { error: (err as Error).message });
      throw new SapError('UNAVAILABLE', 'Your Microsoft sign-in could not be reached right now.', true);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      // IAS names the reason (expired session, IdP not OIDC, consent missing at Entra); it carries no token.
      this.cfg.logger.warn('outlook.token_exchange_refused', { status: res.status, error: body.error, description: body.error_description?.slice(0, 300) });
      if (res.status >= 500) throw new SapError('UNAVAILABLE', 'Your Microsoft sign-in could not be reached right now.', true);
      throw new SapError('NOT_AUTHORIZED', 'Your Microsoft sign-in could not be used for Outlook. Sign out of the workspace and sign in again.');
    }
    if (this.cache.size >= TOKEN_CACHE_SIZE) this.cache.clear();
    this.cache.set(key, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 600) * 1000 });
    return body.access_token;
  }
}

export interface GraphMailGatewayConfig {
  systemId: string;
  /** Windows or IANA time zone name calendar times are returned in. */
  timeZone: string;
  tokens: GraphTokenSource;
  logger: Logger;
  /** Defaults to https://graph.microsoft.com */
  graphUrl?: string;
  fetch?: Fetch;
}

type GraphEntity = Record<string, unknown>;

const SUMMARY_SELECT = 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance,webLink';
const MESSAGE_SELECT = `${SUMMARY_SELECT},toRecipients,ccRecipients,body`;
const EVENT_SELECT = 'id,subject,start,end,isAllDay,location,organizer,attendees,onlineMeeting,showAs,isCancelled,webLink';
const MAX_EVENTS = 100;
/** Longest body the model and the card get. */
const BODY_LIMIT = 8_000;

const str = (v: unknown) => String(v ?? '').trim();
const opt = (v: unknown) => str(v) || undefined;

function address(v: unknown): MailAddress | undefined {
  const e = (v as { emailAddress?: { name?: unknown; address?: unknown } } | undefined)?.emailAddress;
  const addr = str(e?.address);
  if (!addr) return undefined;
  return { ...(opt(e?.name) && { name: opt(e?.name) }), address: addr };
}

const addresses = (v: unknown) => ((Array.isArray(v) ? v : []) as unknown[]).map(address).filter((a): a is MailAddress => !!a);

function toSummary(e: GraphEntity): MailSummary {
  const importance = str(e.importance).toLowerCase();
  return {
    id: str(e.id),
    subject: str(e.subject) || '(no subject)',
    ...(address(e.from) && { from: address(e.from) }),
    receivedAt: str(e.receivedDateTime),
    preview: str(e.bodyPreview).slice(0, 255),
    isRead: e.isRead === true,
    hasAttachments: e.hasAttachments === true,
    importance: importance === 'high' || importance === 'low' ? importance : 'normal',
    ...(opt(e.webLink) && { webLink: opt(e.webLink) }),
  };
}

/** `2026-10-19T09:00:00.0000000` → `2026-10-19T09:00` */
const localTime = (v: unknown) => str((v as { dateTime?: unknown } | undefined)?.dateTime).slice(0, 16);

const RESPONSES: Record<string, AttendeeResponse> = { accepted: 'accepted', organizer: 'accepted', tentativelyaccepted: 'tentative', declined: 'declined' };
const SHOW_AS = ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'] as const;

function toEvent(e: GraphEntity, timeZone: string): CalendarEvent {
  const attendees = (Array.isArray(e.attendees) ? e.attendees : []) as GraphEntity[];
  const showAs = str(e.showAs);
  return {
    id: str(e.id),
    subject: str(e.subject) || '(no subject)',
    start: localTime(e.start),
    end: localTime(e.end),
    timeZone,
    isAllDay: e.isAllDay === true,
    ...(opt((e.location as GraphEntity | undefined)?.displayName) && { location: opt((e.location as GraphEntity).displayName) }),
    ...(address(e.organizer) && { organizer: address(e.organizer) }),
    attendees: attendees.flatMap((a) => {
      const who = address(a);
      if (!who) return [];
      return [{ ...who, response: RESPONSES[str((a.status as GraphEntity | undefined)?.response).toLowerCase()] ?? 'none' }];
    }),
    ...(opt((e.onlineMeeting as GraphEntity | undefined)?.joinUrl) && { joinUrl: opt((e.onlineMeeting as GraphEntity).joinUrl) }),
    showAs: (SHOW_AS as readonly string[]).includes(showAs) ? (showAs as CalendarEvent['showAs']) : 'unknown',
    isCancelled: e.isCancelled === true,
    ...(opt(e.webLink) && { webLink: opt(e.webLink) }),
  };
}

const recipients = (list: string[] | undefined) => (list ?? []).map((a) => ({ emailAddress: { address: a } }));
const graphMessage = (m: NewMail) => ({ subject: m.subject, body: { contentType: 'Text', content: m.body }, toRecipients: recipients(m.to), ccRecipients: recipients(m.cc) });

/** KQL for `$search`. Double quotes delimit the whole search, so they are removed from what the user typed. */
function kql(s: MailSearch): string {
  const clean = (v: string) => v.replaceAll(/["\\]/g, ' ').trim();
  return [s.text && clean(s.text), s.from && `from:${clean(s.from).replaceAll(/\s+/g, '')}`, s.since && `received>=${s.since}`, s.until && `received<=${s.until}`].filter(Boolean).join(' ');
}

/** OData system query options keep their `$`; values are percent-encoded (spaces as %20, never `+`). */
const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

const isTimeout = (err: unknown) => ['TimeoutError', 'AbortError'].includes((err as { name?: string }).name ?? '');
const nextDay = (isoDate: string) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export class GraphMailGateway implements MailGateway {
  readonly mock = false;
  private readonly fetchImpl: Fetch;
  private readonly graphUrl: string;

  constructor(private readonly cfg: GraphMailGatewayConfig) {
    this.fetchImpl = cfg.fetch ?? fetch;
    this.graphUrl = (cfg.graphUrl ?? 'https://graph.microsoft.com').replace(/\/+$/, '');
  }

  get systemId() {
    return this.cfg.systemId;
  }

  get timeZone() {
    return this.cfg.timeZone;
  }

  private async send(ctx: SapCallContext, what: string, method: 'get' | 'post', path: string, opts: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
    const token = await this.cfg.tokens.tokenFor(ctx);
    const started = Date.now();
    const logPath = path.replace(/\/messages\/[^/?]+/, '/messages/<id>').replace(/\/attachments\/[^/?]+/, '/attachments/<id>');
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.graphUrl}${path}${opts.params ? `?${query(opts.params)}` : ''}`, {
          method: method.toUpperCase(),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'client-request-id': ctx.correlationId,
            ...(opts.body !== undefined && { 'content-type': 'application/json' }),
            ...opts.headers,
          },
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        this.cfg.logger.warn('outlook.request_failed', { what, method, path: logPath, error: (err as Error).message });
        if (method === 'post' && isTimeout(err)) throw new SapError('OUTCOME_UNKNOWN', `Outlook did not answer in time for ${what}, so it is not known whether it was done.`);
        throw new SapError('UNAVAILABLE', `Outlook is not reachable right now (${what}).`, true);
      }
      if (res.status === 202 || res.status === 204) return undefined;
      const body = (await res.json().catch(() => ({}))) as GraphEntity & { error?: { code?: string; message?: string } };
      if (res.ok) return body;

      const graphMessage = body.error?.message?.replace(/\s+/g, ' ').slice(0, 300);
      this.cfg.logger.warn('outlook.request_failed', { what, method, path: logPath, status: res.status, code: body.error?.code, ...(graphMessage && { graphMessage }) });
      if (res.status === 404) throw new SapError('NOT_FOUND', `${what} was not found in your mailbox.`);
      if (res.status === 401 || res.status === 403) throw new SapError('NOT_AUTHORIZED', `Outlook denied access to ${what}.`);
      if (res.status === 400) throw new SapError('INVALID_INPUT', `Outlook rejected the request for ${what}${graphMessage ? `: ${graphMessage}` : '.'}`);
      if (res.status === 429 || res.status === 503) throw new SapError('UNAVAILABLE', 'Outlook is limiting requests right now. Try again in a moment.', true);
      throw new SapError('UNAVAILABLE', `Outlook is not reachable right now (${what}).`, true);
    } finally {
      M.sapDuration().observe({ system: this.systemId, method }, Date.now() - started);
    }
  }

  async listMessages(ctx: SapCallContext, q: MailListQuery): Promise<MailSummary[]> {
    const d = (await this.send(ctx, 'Your messages', 'get', `/v1.0/me/mailFolders/${q.folder}/messages`, {
      params: { $select: SUMMARY_SELECT, $orderby: 'receivedDateTime desc', $top: String(q.top), ...(q.unreadOnly && { $filter: 'isRead eq false' }) },
    })) as { value?: GraphEntity[] };
    return (d.value ?? []).map(toSummary);
  }

  async searchMessages(ctx: SapCallContext, s: MailSearch): Promise<MailSummary[]> {
    // Graph does not combine $search with $orderby; search results come back by relevance, so they are sorted here.
    const d = (await this.send(ctx, 'Your messages', 'get', '/v1.0/me/messages', { params: { $select: SUMMARY_SELECT, $top: String(s.top), $search: `"${kql(s)}"` } })) as { value?: GraphEntity[] };
    return (d.value ?? []).map(toSummary).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async getMessage(ctx: SapCallContext, id: string): Promise<MailMessage> {
    const d = (await this.send(ctx, 'The message', 'get', `/v1.0/me/messages/${encodeURIComponent(id)}`, {
      params: { $select: MESSAGE_SELECT, $expand: 'attachments($select=id,name,contentType,size,isInline)' },
      // Graph converts HTML bodies to text, so mail markup never reaches the model or the browser.
      headers: { prefer: 'outlook.body-content-type="text"' },
    })) as GraphEntity;
    const attachments = ((Array.isArray(d.attachments) ? d.attachments : []) as GraphEntity[]).filter((a) => a.isInline !== true);
    return {
      ...toSummary(d),
      to: addresses(d.toRecipients),
      cc: addresses(d.ccRecipients),
      body: str((d.body as GraphEntity | undefined)?.content).slice(0, BODY_LIMIT),
      attachments: attachments.map((a) => ({ ...(opt(a.id) && { id: opt(a.id) }), name: str(a.name), ...(opt(a.contentType) && { contentType: opt(a.contentType) }), ...(typeof a.size === 'number' && { size: a.size }) })),
    };
  }

  async getAttachment(ctx: SapCallContext, messageId: string, attachmentId: string): Promise<AttachmentContent> {
    const d = (await this.send(ctx, 'The attachment', 'get', `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)) as GraphEntity;
    // Attached mail items and cloud links carry no file to read.
    if (str(d['@odata.type']) !== '#microsoft.graph.fileAttachment') throw new SapError('NOT_SUPPORTED', `"${str(d.name)}" is not a file attachment.`);
    if (typeof d.size === 'number' && d.size > MAX_ATTACHMENT_BYTES) throw new SapError('BUSINESS_RULE', `"${str(d.name)}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const bytes = Buffer.from(str(d.contentBytes), 'base64');
    if (!bytes.length) throw new SapError('NOT_FOUND', `"${str(d.name)}" has no content.`);
    return { name: str(d.name), ...(opt(d.contentType) && { contentType: opt(d.contentType) }), bytes };
  }

  async listEvents(ctx: SapCallContext, from: string, to: string): Promise<CalendarEvent[]> {
    const d = (await this.send(ctx, 'Your calendar', 'get', '/v1.0/me/calendarView', {
      params: { startDateTime: `${from}T00:00:00`, endDateTime: `${nextDay(to)}T00:00:00`, $select: EVENT_SELECT, $orderby: 'start/dateTime', $top: String(MAX_EVENTS) },
      headers: { prefer: `outlook.timezone="${this.cfg.timeZone}"` },
    })) as { value?: GraphEntity[] };
    return (d.value ?? []).map((e) => toEvent(e, this.cfg.timeZone));
  }

  async createDraft(ctx: SapCallContext, mail: NewMail) {
    const d = (await this.send(ctx, 'The draft', 'post', '/v1.0/me/messages', { body: graphMessage(mail) })) as GraphEntity;
    return { id: str(d.id), ...(opt(d.webLink) && { webLink: opt(d.webLink) }) };
  }

  async sendMail(ctx: SapCallContext, mail: NewMail) {
    await this.send(ctx, 'The message', 'post', '/v1.0/me/sendMail', { body: { message: graphMessage(mail), saveToSentItems: true } });
  }

  async sendDraft(ctx: SapCallContext, draftId: string) {
    await this.send(ctx, 'The draft', 'post', `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`);
  }

  async reply(ctx: SapCallContext, messageId: string, body: string, replyAll: boolean) {
    await this.send(ctx, 'The message', 'post', `/v1.0/me/messages/${encodeURIComponent(messageId)}/${replyAll ? 'replyAll' : 'reply'}`, { body: { comment: body } });
  }
}
