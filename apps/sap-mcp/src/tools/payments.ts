import { z } from 'zod';
import type { NewPaymentRequest, PaymentRequest } from '../sap/model.js';
import { companyCode, partnerNumber } from './line-items.js';
import { defineTool, fmt, now, type ToolContext, type ToolResultPayload } from './types.js';

const paymentId = z.string().uuid().describe('Id of the payment request, as shown in the payment request list');
const amount = z.coerce.number().positive().max(1_000_000_000).describe('Payment amount');
const currency = z.string().regex(/^[A-Z]{3}$/).default('SAR').describe('Currency, e.g. SAR');
const bankAccount = z.string().regex(/^\d{6,10}$/).describe('Bank G/L account the payment is posted to, e.g. 220001');
const reference = z.string().trim().min(1).max(16).optional().describe('Reference, e.g. the bank statement or cheque number');
const text = z.string().trim().min(1).max(25).optional().describe('Short text for the document header');

const STATUS_LABEL: Record<PaymentRequest['status'], string> = { NEW: 'Waiting for approval', APPROVED: 'Approved', POSTED: 'Posted', REJECTED: 'Rejected' };
const partnerLabel = (p: Pick<PaymentRequest, 'direction'>) => (p.direction === 'INCOMING' ? 'customer' : 'supplier');
const directionLabel = (p: Pick<PaymentRequest, 'direction'>) => (p.direction === 'INCOMING' ? 'Incoming payment' : 'Outgoing payment');
const partnerText = (p: PaymentRequest) => `${p.partnerName ?? p.partner} (${p.partner})`;

function paymentCard(p: PaymentRequest) {
  return {
    type: 'kpi_block' as const,
    data: {
      title: `${directionLabel(p)} · ${p.partnerName ?? p.partner}`,
      items: [
        { label: 'Amount', value: fmt(p.amount) },
        { label: 'Status', value: STATUS_LABEL[p.status], tone: p.status === 'POSTED' ? ('positive' as const) : p.status === 'REJECTED' ? ('critical' as const) : p.status === 'NEW' ? ('warning' as const) : ('neutral' as const) },
        { label: 'Company code', value: p.companyCode },
        { label: 'Bank account', value: p.bankAccount },
        { label: 'Requested by', value: p.createdBy.split('@')[0]!.slice(0, 60) },
        ...(p.approvedBy ? [{ label: 'Approved by', value: p.approvedBy.split('@')[0]!.slice(0, 60) }] : []),
        ...(p.accountingDocument ? [{ label: 'Accounting document', value: p.accountingDocument }] : []),
      ],
    },
  };
}

const paymentSource = (ctx: ToolContext, p: PaymentRequest) => ({ system: ctx.gateway.systemId, objectType: 'PaymentRequest', objectId: p.id, retrievedAt: now(), mock: ctx.gateway.mock });

function paymentResult(ctx: ToolContext, p: PaymentRequest, summary: string, followUps: ToolResultPayload['followUps'] = []): ToolResultPayload {
  return {
    data: { summary, paymentRequest: p.id, status: p.status, ...(p.accountingDocument && { accountingDocument: p.accountingDocument }) },
    components: [paymentCard(p)],
    source: paymentSource(ctx, p),
    followUps,
    outputs: { paymentRequest: p.id, status: p.status, ...(p.accountingDocument && { accountingDocument: p.accountingDocument }) },
  };
}

/** The payment request tools of one direction differ only in the partner and the wording. */
function requestTool(direction: NewPaymentRequest['direction']) {
  const incoming = direction === 'INCOMING';
  const partner = incoming ? 'customer' : 'supplier';
  const title = incoming ? 'Request incoming payment' : 'Request outgoing payment';
  return defineTool({
    name: incoming ? 'ar_requestIncomingPayment' : 'ap_requestOutgoingPayment',
    domain: incoming ? 'ar' : 'ap',
    title,
    description: incoming
      ? 'Create a request to post an incoming customer payment on account (transaction F-28). Nothing is posted yet: a second person must approve the request before it can be posted. Requires user confirmation.'
      : 'Create a request to post an outgoing supplier payment on account (transaction F-53). Nothing is posted yet: a second person must approve the request before it can be posted. Requires user confirmation.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating payment request',
    input: {
      partner: partnerNumber.describe(incoming ? 'SAP customer number, e.g. 7000000010' : 'SAP supplier number, e.g. 7002200010'),
      companyCode,
      amount,
      currency,
      bankAccount,
      reference,
      text,
    },
    async preview(args, ctx) {
      const name = incoming ? (await ctx.gateway.getCustomer(ctx.sap, args.partner)).name : (await ctx.gateway.getVendor(ctx.sap, args.partner)).name;
      const value = fmt({ amount: args.amount, currency: args.currency });
      return {
        action: title,
        businessObject: { type: incoming ? 'Customer' : 'Supplier', id: args.partner },
        proposedChange: incoming
          ? `Request an incoming payment of ${value} from ${name} to bank account ${args.bankAccount} in company code ${args.companyCode}.`
          : `Request an outgoing payment of ${value} to ${name} from bank account ${args.bankAccount} in company code ${args.companyCode}.`,
        impact: 'Only a request is created. It must be approved by a second person and then posted; until then nothing is posted to accounting.',
      };
    },
    async run(args, ctx) {
      const p = await ctx.gateway.createPaymentRequest(ctx.sap, {
        direction,
        companyCode: args.companyCode,
        partner: args.partner,
        amount: args.amount,
        currency: args.currency,
        bankAccount: args.bankAccount,
        ...(args.reference && { reference: args.reference }),
        ...(args.text && { text: args.text }),
      });
      return paymentResult(ctx, p, `A request for an ${incoming ? 'incoming' : 'outgoing'} payment of **${fmt(p.amount)}** ${incoming ? 'from' : 'to'} ${partner} **${partnerText(p)}** was created. It is waiting for approval by a second person.`, [
        { label: 'Payment requests', prompt: `List the payment requests waiting for approval in company code ${p.companyCode}.` },
      ]);
    },
  });
}

/**
 * Payments on account through the SAP payment request service: one person
 * requests, another approves, and only an approved request can be posted.
 * Requests belong to FI-AR and FI-AP; the approval queue and the posting to FI-GL.
 */
export const paymentTools = [
  requestTool('INCOMING'),
  requestTool('OUTGOING'),

  defineTool({
    name: 'gl_listPaymentRequests',
    domain: 'gl',
    title: 'List payment requests',
    description: 'List payment requests and their approval status: waiting for approval (NEW), APPROVED, POSTED or REJECTED. Use it as the approval queue.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving payment requests',
    input: {
      companyCode: companyCode.optional(),
      status: z.enum(['NEW', 'APPROVED', 'POSTED', 'REJECTED']).optional().describe('NEW = waiting for approval. Omit to list all.'),
    },
    async run({ companyCode, status }, ctx) {
      const payments = await ctx.gateway.listPaymentRequests(ctx.sap, { ...(companyCode && { companyCode }), ...(status && { status }) });
      const scope = `payment request(s)${status ? ` with status "${STATUS_LABEL[status]}"` : ''}${companyCode ? ` in company code ${companyCode}` : ''}`;
      const waiting = payments.filter((p) => p.status === 'NEW');
      const approved = payments.filter((p) => p.status === 'APPROVED');
      return {
        data: {
          summary: !payments.length
            ? `There are no ${scope}.`
            : status
              ? `${payments.length} ${scope}.`
              : `${payments.length} ${scope}: ${waiting.length} waiting for approval and ${approved.length} approved but not yet posted.`,
          paymentRequests: payments.map((p) => ({ id: p.id, direction: p.direction, [partnerLabel(p)]: partnerText(p), amount: fmt(p.amount), status: p.status, requestedBy: p.createdBy, accountingDocument: p.accountingDocument })),
        },
        components: payments.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Payment requests${companyCode ? ` · company code ${companyCode}` : ''}`,
                  columns: [
                    { key: 'type', label: 'Type' },
                    { key: 'partner', label: 'Customer / supplier' },
                    { key: 'amount', label: 'Amount', align: 'right' },
                    { key: 'status', label: 'Status' },
                    { key: 'requestedBy', label: 'Requested by' },
                    { key: 'document', label: 'Document' },
                    { key: 'id', label: 'Request id' },
                  ],
                  rows: payments.slice(0, 200).map((p) => ({
                    type: directionLabel(p),
                    partner: partnerText(p),
                    amount: fmt(p.amount),
                    status: STATUS_LABEL[p.status],
                    requestedBy: p.createdBy,
                    document: p.accountingDocument ?? null,
                    id: p.id,
                  })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'PaymentRequests', objectId: companyCode ?? 'all', retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [
          ...waiting.slice(0, 2).map((p) => ({ label: `Approve ${fmt(p.amount)}`, prompt: `Approve payment request ${p.id}.` })),
          ...approved.slice(0, 2).map((p) => ({ label: `Post ${fmt(p.amount)}`, prompt: `Post payment request ${p.id}.` })),
        ],
      };
    },
  }),

  defineTool({
    name: 'gl_approvePaymentRequest',
    domain: 'gl',
    title: 'Approve payment request',
    description: 'Approve a payment request that another person created, so it can be posted. SAP refuses approval by the person who created the request. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Approving payment request',
    input: { paymentRequest: paymentId },
    async preview({ paymentRequest }, ctx) {
      const p = await ctx.gateway.getPaymentRequest(ctx.sap, paymentRequest);
      return {
        action: 'Approve payment request',
        businessObject: { type: 'Payment request', id: p.id },
        proposedChange: `Approve the ${directionLabel(p).toLowerCase()} of ${fmt(p.amount)} for ${partnerLabel(p)} ${partnerText(p)}, requested by ${p.createdBy}.`,
        impact: 'After approval the payment can be posted to accounting. SAP rejects the approval if you created the request yourself.',
      };
    },
    async run({ paymentRequest }, ctx) {
      const p = await ctx.gateway.approvePaymentRequest(ctx.sap, paymentRequest);
      return paymentResult(ctx, p, `The ${directionLabel(p).toLowerCase()} of **${fmt(p.amount)}** for ${partnerLabel(p)} **${partnerText(p)}** was approved and can now be posted.`, [
        { label: 'Post the payment', prompt: `Post payment request ${p.id}.` },
      ]);
    },
  }),

  defineTool({
    name: 'gl_rejectPaymentRequest',
    domain: 'gl',
    title: 'Reject payment request',
    description: 'Reject a payment request that is waiting for approval or approved but not yet posted. A rejected request can no longer be posted. Requires user confirmation.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Rejecting payment request',
    input: { paymentRequest: paymentId },
    async preview({ paymentRequest }, ctx) {
      const p = await ctx.gateway.getPaymentRequest(ctx.sap, paymentRequest);
      return {
        action: 'Reject payment request',
        businessObject: { type: 'Payment request', id: p.id },
        proposedChange: `Reject the ${directionLabel(p).toLowerCase()} of ${fmt(p.amount)} for ${partnerLabel(p)} ${partnerText(p)}, requested by ${p.createdBy}.`,
        impact: 'The request is closed without a posting. A new request is needed if the payment is to be made after all.',
      };
    },
    async run({ paymentRequest }, ctx) {
      const p = await ctx.gateway.rejectPaymentRequest(ctx.sap, paymentRequest);
      return paymentResult(ctx, p, `The ${directionLabel(p).toLowerCase()} of **${fmt(p.amount)}** for ${partnerLabel(p)} **${partnerText(p)}** was rejected. Nothing was posted.`);
    },
  }),

  defineTool({
    name: 'gl_postPaymentRequest',
    domain: 'gl',
    title: 'Post payment',
    description:
      'Post an approved payment request to accounting as a payment on account (document type DZ for incoming, KZ for outgoing). The payment is not cleared against invoices. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Posting payment',
    input: { paymentRequest: paymentId },
    async preview({ paymentRequest }, ctx) {
      const p = await ctx.gateway.getPaymentRequest(ctx.sap, paymentRequest);
      const incoming = p.direction === 'INCOMING';
      return {
        action: 'Post payment',
        businessObject: { type: 'Payment request', id: p.id },
        proposedChange:
          p.status === 'APPROVED'
            ? `Post ${fmt(p.amount)}: ${incoming ? `debit bank account ${p.bankAccount}, credit customer ${partnerText(p)}` : `debit supplier ${partnerText(p)}, credit bank account ${p.bankAccount}`}.`
            : `This request is ${STATUS_LABEL[p.status].toLowerCase()} — SAP will reject the posting.`,
        impact: `An accounting document is created in company code ${p.companyCode}. The payment stays as an open item on the ${partnerLabel(p)} account until it is cleared against invoices; undoing it requires a reversal.`,
      };
    },
    async run({ paymentRequest }, ctx) {
      const p = await ctx.gateway.postPaymentRequest(ctx.sap, paymentRequest);
      return paymentResult(
        ctx,
        p,
        `The ${directionLabel(p).toLowerCase()} of **${fmt(p.amount)}** for ${partnerLabel(p)} **${partnerText(p)}** was posted${p.accountingDocument ? ` as accounting document **${p.accountingDocument}**` : ''}. It is on the account as a payment on account and still has to be cleared against the invoices.`,
        [{ label: 'Account line items', prompt: `Show the open items of ${partnerLabel(p)} ${p.partner} in company code ${p.companyCode}.` }],
      );
    },
  }),
];
