import { createLogger } from '@prowess/observability';
import { beforeEach, describe, expect, it } from 'vitest';
import { GRAPH_SCOPES, GraphMailGateway, IasGraphTokens } from '../src/outlook/graph-gateway.js';

interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// fetch is replaced by a recorder: these tests check what goes to IAS and Graph, and how the replies are read.
let sent: Sent[] = [];
let reply: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const req: Sent = { url: new URL(String(input)), method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), ...(init.body !== undefined && { body: String(init.body) }) };
  sent.push(req);
  const r = reply(req);
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const logger = createLogger({ service: 't', level: 'error', sink: () => {} });
const iasCfg = { iasUrl: 'https://tenant.accounts.ondemand.com/', clientId: 'ias-client', clientSecret: 'ias$secret=', scopes: GRAPH_SCOPES, logger };
const ctx = (iasToken: string | undefined = 'ias.user.token') => ({ principal: { sub: 'alex@prowess.example', tenant: 't1' }, ...(iasToken && { iasToken }), correlationId: 'PRW-1' }) as never;

/** IAS answers the exchange with a Graph token; everything else is up to the test. */
function withGraph(graph: (req: Sent) => { status: number; body?: unknown }) {
  reply = (req) => (req.url.hostname === 'tenant.accounts.ondemand.com' ? { status: 200, body: { access_token: 'graph-token', token_type: 'Bearer', expires_in: 3600 } } : graph(req));
}

const gateway = () => new GraphMailGateway({ systemId: 'M365-DEV', timeZone: 'Arab Standard Time', tokens: new IasGraphTokens(iasCfg, fakeFetch), logger, fetch: fakeFetch });
const graphCalls = () => sent.filter((r) => r.url.hostname === 'graph.microsoft.com');

beforeEach(() => {
  sent = [];
  reply = () => ({ status: 200, body: {} });
});

describe('IAS Graph tokens', () => {
  it("exchanges the user's IAS token at the corporate IdP endpoint for Graph scopes, once per token", async () => {
    withGraph(() => ({ status: 200, body: { value: [] } }));
    const g = gateway();
    await g.listMessages(ctx(), { folder: 'inbox', unreadOnly: false, top: 5 });
    await g.listMessages(ctx(), { folder: 'inbox', unreadOnly: false, top: 5 });
    const exchanges = sent.filter((r) => r.url.pathname === '/oauth2/exchange/corporateidp');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.headers.authorization).toBe(`Basic ${Buffer.from('ias-client:ias$secret=').toString('base64')}`);
    const form = new URLSearchParams(exchanges[0]!.body);
    expect(form.get('assertion')).toBe('ias.user.token');
    expect(form.get('response_type')).toBe('token');
    expect(form.get('scope')).toContain('https://graph.microsoft.com/Mail.ReadWrite');
    expect(graphCalls()[0]!.headers.authorization).toBe('Bearer graph-token');
  });

  it('refuses without an IAS token: there is no technical user', async () => {
    await expect(gateway().listMessages(ctx(''), { folder: 'inbox', unreadOnly: false, top: 5 })).rejects.toThrow(/sign in again/);
    expect(sent).toHaveLength(0);
  });

  it('reports a refused exchange as an authorization problem', async () => {
    reply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'session expired' } });
    await expect(gateway().listMessages(ctx(), { folder: 'inbox', unreadOnly: false, top: 5 })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
});

describe('Graph mail gateway', () => {
  it("reads the user's inbox on /me", async () => {
    withGraph(() => ({
      status: 200,
      body: { value: [{ id: 'AAMk1', subject: 'Hello', from: { emailAddress: { name: 'Nadia', address: 'nadia@supplier.example' } }, receivedDateTime: '2026-10-19T07:00:00Z', bodyPreview: 'Hi', isRead: false, hasAttachments: true, importance: 'High' }] },
    }));
    const [m] = await gateway().listMessages(ctx(), { folder: 'inbox', unreadOnly: true, top: 5 });
    const req = graphCalls()[0]!;
    expect(req.url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    expect(req.url.searchParams.get('$top')).toBe('5');
    expect(req.url.searchParams.get('$filter')).toBe('isRead eq false');
    expect(req.url.search).not.toContain('+'); // spaces are %20, which Graph reads in every option
    expect(m).toMatchObject({ id: 'AAMk1', from: { name: 'Nadia', address: 'nadia@supplier.example' }, isRead: false, importance: 'high' });
  });

  it('builds a KQL search and strips quotes the user typed', async () => {
    withGraph(() => ({ status: 200, body: { value: [] } }));
    await gateway().searchMessages(ctx(), { text: 'invoice "5100012345"', from: 'nadia@supplier.example', since: '2026-10-01', top: 10 });
    expect(graphCalls()[0]!.url.searchParams.get('$search')).toBe('"invoice  5100012345 from:nadia@supplier.example received>=2026-10-01"');
  });

  it('asks Graph for a plain-text body and leaves inline attachments out', async () => {
    withGraph(() => ({
      status: 200,
      body: { id: 'AAMk1', subject: 'Hello', receivedDateTime: '2026-10-19T07:00:00Z', body: { content: 'Plain body' }, toRecipients: [{ emailAddress: { address: 'alex@prowess.example' } }], attachments: [{ name: 'invoice.pdf', size: 1000 }, { name: 'logo.png', isInline: true }] },
    }));
    const m = await gateway().getMessage(ctx(), 'AAMk/1+=');
    expect(graphCalls()[0]!.url.pathname).toBe('/v1.0/me/messages/AAMk%2F1%2B%3D');
    expect(graphCalls()[0]!.headers.prefer).toBe('outlook.body-content-type="text"');
    expect(m.body).toBe('Plain body');
    expect(m.attachments).toEqual([{ name: 'invoice.pdf', size: 1000 }]);
  });

  it('reads the calendar view in the configured time zone', async () => {
    withGraph(() => ({
      status: 200,
      body: {
        value: [
          {
            id: 'E1',
            subject: 'Stand-up',
            start: { dateTime: '2026-10-19T09:00:00.0000000' },
            end: { dateTime: '2026-10-19T09:15:00.0000000' },
            attendees: [{ emailAddress: { name: 'Jordan', address: 'jordan@prowess.example' }, status: { response: 'tentativelyAccepted' } }],
            onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
            showAs: 'busy',
          },
        ],
      },
    }));
    const [e] = await gateway().listEvents(ctx(), '2026-10-19', '2026-10-19');
    const req = graphCalls()[0]!;
    expect(req.url.searchParams.get('startDateTime')).toBe('2026-10-19T00:00:00');
    expect(req.url.searchParams.get('endDateTime')).toBe('2026-10-20T00:00:00');
    expect(req.headers.prefer).toBe('outlook.timezone="Arab Standard Time"');
    expect(e).toMatchObject({ start: '2026-10-19T09:00', end: '2026-10-19T09:15', attendees: [{ address: 'jordan@prowess.example', response: 'tentative' }], joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' });
  });

  it('sends mail as plain text and saves it to sent items', async () => {
    withGraph(() => ({ status: 202 }));
    await gateway().sendMail(ctx(), { to: ['mei@prowess.example'], subject: 'Hi', body: 'Text' });
    const req = graphCalls()[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.pathname).toBe('/v1.0/me/sendMail');
    expect(JSON.parse(req.body!)).toEqual({ message: { subject: 'Hi', body: { contentType: 'Text', content: 'Text' }, toRecipients: [{ emailAddress: { address: 'mei@prowess.example' } }], ccRecipients: [] }, saveToSentItems: true });
  });

  it('maps Graph errors to safe messages', async () => {
    const fail = (status: number) => withGraph(() => ({ status, body: { error: { code: 'X', message: 'Graph said no' } } }));
    fail(403);
    await expect(gateway().getMessage(ctx(), 'AAMk1')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    fail(404);
    await expect(gateway().getMessage(ctx(), 'AAMk1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fail(429);
    await expect(gateway().getMessage(ctx(), 'AAMk1')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    fail(400);
    await expect(gateway().sendMail(ctx(), { to: ['x@prowess.example'], subject: 's', body: 'b' })).rejects.toThrow(/Graph said no/);
  });
});
