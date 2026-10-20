import { randomUUID } from 'node:crypto';
import { SapError, type SapCallContext } from '../sap/model.js';
import type { ExtractedDocument } from './document-ai.js';
import { textPdf } from './mock-pdf.js';
import type { AttachmentContent, CalendarEvent, MailGateway, MailListQuery, MailMessage, MailSearch, MailSummary, NewMail } from './model.js';

/**
 * Mock Outlook for local development and CI. Every mailbox and person is
 * fictitious. Each development identity of the orchestrator has its own
 * mailbox and calendar, and nobody can open another user's, as in Exchange.
 * Sent mail and drafts are kept in memory for the life of the process.
 */

const DOMAIN = 'prowess.example';
const at = (local: string) => `${local}@${DOMAIN}`;

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** File contents of the seeded attachments, by attachment id. */
const FILES = new Map<string, AttachmentContent>();

function file(id: string, name: string, contentType: string, bytes: Buffer) {
  FILES.set(id, { name, contentType, bytes });
  return { id, name, contentType, size: bytes.length };
}

// assumed: supplier invoices as they arrive from suppliers, matching the mock purchase orders
const GULF_INVOICE = file(
  'AAMkAtt-alex-005-1',
  'GIS-2026-0815.pdf',
  'application/pdf',
  textPdf([
    'Gulf Industrial Supplies',
    'Sheikh Zayed Road 44, Dubai',
    '',
    'TAX INVOICE',
    'Invoice number: GIS-2026-0815',
    'Invoice date: 2026-10-14',
    'Your purchase order: 4500012410',
    '',
    'Item  Description               Qty   Unit price    Amount',
    '10    Pump mechanical seal kit  40 EA  4,250.00   170,000.00',
    '',
    'Net amount          SAR 170,000.00',
    'VAT 12%             SAR  20,400.00',
    'Total amount due    SAR 190,400.00',
    '',
    'Payment terms: 30 days net',
  ]),
);
const ALQASSIM_INVOICE = file(
  'AAMkAtt-alex-006-1',
  'VEN004.pdf',
  'application/pdf',
  textPdf([
    'AL-QASSIM Trading Est.',
    '',
    'INVOICE VEN004',
    'Date: 2026-10-16',
    'PO reference: 4200000403',
    '',
    '3 PC  Material 5496 at SAR 1,000.00  =  SAR 3,000.00',
    'VAT 12%: SAR 360.00',
    'Total: SAR 3,360.00',
  ]),
);
// assumed: a scanned paper invoice (an image without text); the mock Document AI knows what it says
const ABC_SCAN = file(
  'AAMkAtt-alex-007-1',
  'scan_ABC-INV-2291.png',
  'image/png',
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/** What the mock SAP Document AI recognizes in the scanned attachments of the mock mailbox, by file name. */
export const MOCK_SCANS = new Map<string, ExtractedDocument>([
  [
    ABC_SCAN.name,
    {
      fields: [
        { name: 'senderName', value: 'ABC Trading LLC', confidence: 0.97 },
        { name: 'documentNumber', value: 'ABC-INV-2291', confidence: 0.95 },
        { name: 'documentDate', value: '2026-10-11', confidence: 0.93 },
        { name: 'purchaseOrderNumber', value: '4500012345', confidence: 0.62 },
        { name: 'currencyCode', value: 'SAR', confidence: 0.99 },
        { name: 'netAmount', value: '123000.00', confidence: 0.91 },
        { name: 'taxAmount', value: '14760.00', confidence: 0.9 },
        { name: 'grossAmount', value: '137760.00', confidence: 0.94 },
      ],
      lineItems: [
        [
          { name: 'description', value: 'Stainless steel coil 316L', confidence: 0.88 },
          { name: 'quantity', value: '60', confidence: 0.92 },
          { name: 'unitOfMeasure', value: 'TO', confidence: 0.9 },
          { name: 'unitPrice', value: '2050.00', confidence: 0.89 },
          { name: 'netAmount', value: '123000.00', confidence: 0.9 },
        ],
      ],
    },
  ],
]);

const PAYMENT_PROPOSAL = file('AAMkAtt-alex-003-1', 'F110-proposal.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

interface Mailbox {
  messages: (MailMessage & { folder: 'inbox' | 'sentitems' | 'drafts' })[];
  events: CalendarEvent[];
}

function message(id: string, folder: 'inbox' | 'sentitems', fromName: string, fromAddress: string, to: string, subject: string, body: string, ageHours: number, extra: Partial<MailMessage> = {}) {
  return {
    id,
    folder,
    subject,
    from: { name: fromName, address: fromAddress },
    to: [{ address: to }],
    cc: [],
    receivedAt: hoursAgo(ageHours),
    preview: body.replace(/\s+/g, ' ').slice(0, 160),
    body,
    isRead: ageHours > 20,
    hasAttachments: Boolean(extra.attachments?.length),
    importance: 'normal' as const,
    attachments: [],
    webLink: `https://outlook.office.com/mail/id/${id}`,
    ...extra,
  };
}

function event(id: string, subject: string, day: number, from: string, to: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const date = dayOffset(day);
  return {
    id,
    subject,
    start: `${date}T${from}`,
    end: `${date}T${to}`,
    timeZone: 'Arab Standard Time',
    isAllDay: false,
    attendees: [],
    showAs: 'busy',
    isCancelled: false,
    webLink: `https://outlook.office.com/calendar/item/${id}`,
    ...extra,
  };
}

function seed(): Map<string, Mailbox> {
  const alex = at('alex.morgan');
  const sam = at('sam.rivera');
  return new Map([
    [
      alex,
      {
        messages: [
          message(
            'AAMk-alex-001',
            'inbox',
            'Gulf Steel Supplies',
            'accounts@gulfsteel.example',
            alex,
            'Invoice 5100012345 still unpaid',
            'Dear Alex,\n\nOur invoice 5100012345 dated last month is still open in your system. Could you let us know why payment is held and when we can expect it?\n\nKind regards,\nNadia Saleh\nAccounts Receivable, Gulf Steel Supplies',
            3,
            { importance: 'high' },
          ),
          message(
            'AAMk-alex-002',
            'inbox',
            'Priya Nair',
            at('priya.nair'),
            alex,
            'Month-end close: open GR/IR items',
            'Hi Alex,\n\nBefore Thursday please review the open GR/IR items for company code 1030 and tell me which ones need an accrual.\n\nThanks,\nPriya',
            9,
          ),
          message(
            'AAMk-alex-003',
            'inbox',
            'Jordan Lee',
            at('jordan.lee'),
            alex,
            'Payment run proposal for Friday',
            'Alex, the payment run proposal for Friday is ready. Two invoices are excluded because of a price variance. Shall I release the rest?\n\nJordan',
            26,
            { attachments: [PAYMENT_PROPOSAL] },
          ),
          message(
            'AAMk-alex-005',
            'inbox',
            'Gulf Industrial Supplies',
            'billing@gulfindustrial.example',
            alex,
            'Invoice GIS-2026-0815 for PO 4500012410',
            'Dear Accounts Payable,\n\nPlease find attached our invoice GIS-2026-0815 for the pump seal kits delivered against your purchase order 4500012410.\n\nBest regards,\nBilling, Gulf Industrial Supplies',
            4,
            { attachments: [GULF_INVOICE] },
          ),
          message(
            'AAMk-alex-006',
            'inbox',
            'AL-QASSIM Trading',
            'ar@alqassim.example',
            alex,
            'Invoice VEN004',
            'Hello,\n\nAttached is invoice VEN004 for order 4200000403. The goods ship this week.\n\nRegards,\nAL-QASSIM',
            6,
            { attachments: [ALQASSIM_INVOICE] },
          ),
          message(
            'AAMk-alex-007',
            'inbox',
            'ABC Trading LLC',
            'finance@abctrading.example',
            alex,
            'Scanned invoice ABC-INV-2291',
            'Hello,\n\nPlease find our scanned invoice ABC-INV-2291 attached.\n\nThank you,\nABC Trading LLC',
            8,
            { attachments: [ABC_SCAN] },
          ),
          message(
            'AAMk-alex-004',
            'inbox',
            'IT Service Desk',
            at('servicedesk'),
            alex,
            'Planned maintenance on Saturday',
            'S/4HANA will be unavailable on Saturday from 22:00 to 02:00 for planned maintenance.',
            50,
          ),
          message('AAMk-alex-101', 'sentitems', 'Alex Morgan', alex, at('mei.tanaka'), 'Vendor statement reconciliation', 'Mei, please reconcile the Gulf Steel statement against our open items by Wednesday. Thanks, Alex', 30),
        ],
        events: [
          event('AAMkEv-alex-1', 'AP stand-up', 0, '09:00', '09:15', { location: 'Teams', joinUrl: 'https://teams.microsoft.com/l/meetup-join/mock-standup', organizer: { name: 'Alex Morgan', address: alex }, attendees: [{ name: 'Jordan Lee', address: at('jordan.lee'), response: 'accepted' }, { name: 'Mei Tanaka', address: at('mei.tanaka'), response: 'accepted' }] }),
          event('AAMkEv-alex-2', 'Month-end close review', 0, '14:00', '15:00', { location: 'Riyadh HQ, Room 4.12', organizer: { name: 'Priya Nair', address: at('priya.nair') }, attendees: [{ name: 'Alex Morgan', address: alex, response: 'tentative' }] }),
          event('AAMkEv-alex-3', 'Gulf Steel supplier call', 1, '11:00', '11:30', { location: 'Teams', joinUrl: 'https://teams.microsoft.com/l/meetup-join/mock-supplier', organizer: { name: 'Alex Morgan', address: alex }, attendees: [{ name: 'Nadia Saleh', address: 'accounts@gulfsteel.example', response: 'none' }] }),
          event('AAMkEv-alex-4', 'Annual leave', 9, '00:00', '00:00', { isAllDay: true, end: `${dayOffset(12)}T00:00`, showAs: 'oof' }),
        ],
      },
    ],
    [
      sam,
      {
        messages: [
          message('AAMk-sam-001', 'inbox', 'Omar Haddad', at('omar.haddad'), sam, 'Offer letter for the AP accountant role', 'Sam, the offer letter for the new AP accountant is ready for your approval in SuccessFactors.\n\nOmar', 5),
          message('AAMk-sam-002', 'inbox', 'Dana Whitfield', at('dana.whitfield'), sam, 'Town hall agenda', 'Sam, can you send me the HR section of the town hall agenda by tomorrow?\n\nDana', 28),
        ],
        events: [
          event('AAMkEv-sam-1', 'Leadership meeting', 0, '10:00', '11:00', { location: 'Riyadh HQ, Board room', organizer: { name: 'Dana Whitfield', address: at('dana.whitfield') } }),
          event('AAMkEv-sam-2', 'Interview: AP accountant', 2, '13:00', '14:00', { location: 'Teams', joinUrl: 'https://teams.microsoft.com/l/meetup-join/mock-interview' }),
        ],
      },
    ],
  ]);
}

const summary = ({ body: _body, to: _to, cc: _cc, attachments: _a, folder: _f, ...rest }: Mailbox['messages'][number]): MailSummary => rest;
const newest = (a: MailSummary, b: MailSummary) => b.receivedAt.localeCompare(a.receivedAt);

export class MockMailGateway implements MailGateway {
  readonly systemId = 'M365-MOCK';
  readonly mock = true;
  readonly timeZone = 'Arab Standard Time';
  private readonly mailboxes = seed();

  constructor(private readonly latencyMs = 0) {}

  private async latency() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  /** The caller's own mailbox. Users without one have no Outlook licence in the mock tenant. */
  private mailbox(ctx: SapCallContext): Mailbox {
    const box = this.mailboxes.get(ctx.principal.sub.toLowerCase());
    if (!box) throw new SapError('NOT_FOUND', 'No Outlook mailbox is linked to your login.');
    return box;
  }

  private find(ctx: SapCallContext, id: string) {
    const hit = this.mailbox(ctx).messages.find((m) => m.id === id);
    if (!hit) throw new SapError('NOT_FOUND', 'The message was not found in your mailbox.');
    return hit;
  }

  async listMessages(ctx: SapCallContext, q: MailListQuery): Promise<MailSummary[]> {
    await this.latency();
    return this.mailbox(ctx)
      .messages.filter((m) => m.folder === q.folder && (!q.unreadOnly || !m.isRead))
      .map(summary)
      .sort(newest)
      .slice(0, q.top);
  }

  async searchMessages(ctx: SapCallContext, s: MailSearch): Promise<MailSummary[]> {
    await this.latency();
    const words = (s.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const from = s.from?.toLowerCase();
    return this.mailbox(ctx)
      .messages.filter((m) => (s.folder ? m.folder === s.folder : m.folder !== 'drafts'))
      .filter((m) => words.every((w) => `${m.subject} ${m.body}`.toLowerCase().includes(w)))
      .filter((m) => !from || `${m.from?.name ?? ''} ${m.from?.address ?? ''}`.toLowerCase().includes(from))
      .filter((m) => (!s.since || m.receivedAt.slice(0, 10) >= s.since) && (!s.until || m.receivedAt.slice(0, 10) <= s.until))
      .map(summary)
      .sort(newest)
      .slice(0, s.top);
  }

  async getMessage(ctx: SapCallContext, id: string): Promise<MailMessage> {
    await this.latency();
    const { folder: _folder, ...m } = this.find(ctx, id);
    return structuredClone(m);
  }

  async getAttachment(ctx: SapCallContext, messageId: string, attachmentId: string): Promise<AttachmentContent> {
    await this.latency();
    const m = this.find(ctx, messageId);
    const content = m.attachments.some((a) => a.id === attachmentId) && FILES.get(attachmentId);
    if (!content) throw new SapError('NOT_FOUND', 'The attachment was not found in your mailbox.');
    return { ...content, bytes: Buffer.from(content.bytes) };
  }

  async listEvents(ctx: SapCallContext, from: string, to: string): Promise<CalendarEvent[]> {
    await this.latency();
    return this.mailbox(ctx)
      .events.filter((e) => e.start.slice(0, 10) <= to && e.end.slice(0, 10) >= from)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((e) => structuredClone(e));
  }

  private store(ctx: SapCallContext, mail: NewMail, folder: 'sentitems' | 'drafts') {
    const id = `AAMk-${folder}-${randomUUID()}`;
    const from = { name: ctx.principal.name, address: ctx.principal.sub };
    this.mailbox(ctx).messages.push(
      message(id, folder as 'sentitems', from.name, from.address, mail.to.join(', '), mail.subject, mail.body, 0, {
        to: mail.to.map((address) => ({ address })),
        cc: (mail.cc ?? []).map((address) => ({ address })),
        isRead: true,
      }),
    );
    return id;
  }

  async createDraft(ctx: SapCallContext, mail: NewMail) {
    await this.latency();
    const id = this.store(ctx, mail, 'drafts');
    return { id, webLink: `https://outlook.office.com/mail/drafts/id/${id}` };
  }

  async sendMail(ctx: SapCallContext, mail: NewMail) {
    await this.latency();
    this.store(ctx, mail, 'sentitems');
  }

  async sendDraft(ctx: SapCallContext, draftId: string) {
    await this.latency();
    const draft = this.find(ctx, draftId);
    if (draft.folder !== 'drafts') throw new SapError('BUSINESS_RULE', 'Only a draft can be sent.');
    draft.folder = 'sentitems';
    draft.receivedAt = new Date().toISOString();
  }

  async reply(ctx: SapCallContext, messageId: string, body: string, replyAll: boolean) {
    await this.latency();
    const original = this.find(ctx, messageId);
    const to = [original.from?.address, ...(replyAll ? [...original.to, ...original.cc].map((a) => a.address) : [])].filter((a): a is string => !!a && a !== ctx.principal.sub);
    this.store(ctx, { to: [...new Set(to)], subject: `RE: ${original.subject}`, body }, 'sentitems');
  }
}
