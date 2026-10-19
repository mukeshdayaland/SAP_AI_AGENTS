import type { SapCallContext } from '../sap/model.js';

/**
 * Outlook (Microsoft 365) domain model, the port between the `outlook` tools
 * and Microsoft Graph. Gateways raise `SapError`, so the MCP server reports a
 * Graph failure the same way as an SAP one. Every call is made as the
 * signed-in user: Exchange decides which mailbox and calendar they may open.
 */

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailSummary {
  id: string;
  subject: string;
  from?: MailAddress;
  /** ISO timestamp, UTC. */
  receivedAt: string;
  /** The first characters of the body, as Outlook shows them in the list. */
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: 'low' | 'normal' | 'high';
  /** Opens the message in Outlook on the web. */
  webLink?: string;
}

export interface MailAttachment {
  /** Graph attachment id; absent on cards of messages that have not been sent yet. */
  id?: string;
  name: string;
  contentType?: string;
  size?: number;
}

export interface MailMessage extends MailSummary {
  to: MailAddress[];
  cc: MailAddress[];
  /** Plain text. HTML bodies are converted by Graph; never rendered as HTML. */
  body: string;
  attachments: MailAttachment[];
}

/** The bytes of one file attached to a message. */
export interface AttachmentContent {
  name: string;
  contentType?: string;
  bytes: Buffer;
}

/** Largest attachment that is downloaded; Graph returns file attachments inline up to this size. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAIL_FOLDERS = ['inbox', 'sentitems', 'drafts'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export interface MailListQuery {
  folder: MailFolder;
  unreadOnly: boolean;
  top: number;
}

export interface MailSearch {
  /** Words to look for in subject and body. */
  text?: string;
  /** Sender address or name. */
  from?: string;
  /** YYYY-MM-DD, both days included. */
  since?: string;
  until?: string;
  top: number;
}

export type AttendeeResponse = 'accepted' | 'tentative' | 'declined' | 'none';

export interface CalendarEvent {
  id: string;
  subject: string;
  /** Local date-time in `timeZone`, `YYYY-MM-DDTHH:mm`. */
  start: string;
  end: string;
  timeZone: string;
  isAllDay: boolean;
  location?: string;
  organizer?: MailAddress;
  attendees: (MailAddress & { response: AttendeeResponse })[];
  /** Teams or other online meeting link. */
  joinUrl?: string;
  showAs: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  isCancelled: boolean;
  webLink?: string;
}

/** A new message. The body is plain text. */
export interface NewMail {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface MailGateway {
  readonly systemId: string;
  readonly mock: boolean;
  /** The time zone calendar times are given in. */
  readonly timeZone: string;

  listMessages(ctx: SapCallContext, query: MailListQuery): Promise<MailSummary[]>;
  searchMessages(ctx: SapCallContext, search: MailSearch): Promise<MailSummary[]>;
  getMessage(ctx: SapCallContext, id: string): Promise<MailMessage>;
  /** One file attached to a message of the user. Item and reference attachments are refused. */
  getAttachment(ctx: SapCallContext, messageId: string, attachmentId: string): Promise<AttachmentContent>;
  /** Events, including occurrences of recurring ones, that overlap the range (YYYY-MM-DD, both days included). */
  listEvents(ctx: SapCallContext, from: string, to: string): Promise<CalendarEvent[]>;

  /** Saves a draft in the user's Drafts folder. Nothing is sent. */
  createDraft(ctx: SapCallContext, mail: NewMail): Promise<{ id: string; webLink?: string }>;
  sendMail(ctx: SapCallContext, mail: NewMail): Promise<void>;
  sendDraft(ctx: SapCallContext, draftId: string): Promise<void>;
  reply(ctx: SapCallContext, messageId: string, body: string, replyAll: boolean): Promise<void>;
}
