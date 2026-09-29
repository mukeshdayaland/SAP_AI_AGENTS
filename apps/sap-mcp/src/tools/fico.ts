import { z } from 'zod';
import type { Invoice } from '../sap/model.js';
import { defineTool, fmt, now, type ToolContext, type ToolResultPayload } from './types.js';

const invoiceNumber = z.string().regex(/^\d{10}$/, 'SAP invoice numbers have 10 digits').describe('Supplier invoice document number, e.g. 5100012345');
const fiscalYear = z.string().regex(/^\d{4}$/).describe('Fiscal year, e.g. 2026');

function invoiceComponent(inv: Invoice, blockReasons?: string[]) {
  return {
    type: 'invoice' as const,
    data: {
      number: inv.number,
      fiscalYear: inv.fiscalYear,
      companyCode: inv.companyCode,
      vendorId: inv.vendorId,
      vendorName: inv.vendorName,
      amount: inv.gross,
      ...(inv.postingDate && { postingDate: inv.postingDate }),
      ...(inv.dueDate && { dueDate: inv.dueDate }),
      status: inv.status,
      paymentBlock: inv.paymentBlock,
      ...(inv.purchaseOrder && { purchaseOrder: inv.purchaseOrder }),
      ...(blockReasons?.length && { blockReasons }),
    },
  };
}

function invoiceSource(ctx: ToolContext, inv: Invoice) {
  return { system: ctx.gateway.systemId, objectType: 'SupplierInvoice', objectId: `${inv.number}/${inv.fiscalYear}`, retrievedAt: now(), mock: ctx.gateway.mock };
}

function invoiceFollowUps(inv: Invoice) {
  return [
    { label: 'Analyze vendor', prompt: `Review vendor ${inv.vendorId} exposure and payment behaviour.` },
    ...(inv.purchaseOrder ? [{ label: 'Check related PO', prompt: `Check purchase order ${inv.purchaseOrder} and its goods receipts.` }] : []),
    ...(inv.paymentBlock ? [{ label: 'Release payment block', prompt: `Release the payment block on invoice ${inv.number}.` }] : []),
  ];
}

function invoiceFacts(inv: Invoice): ToolResultPayload['data'] {
  const failed = (inv.varianceChecks ?? []).filter((c) => !c.withinTolerance);
  const summary = inv.paymentBlock
    ? `Invoice **${inv.number}** from **${inv.vendorName}** (${fmt(inv.gross)}) is **blocked for payment** with block key **${inv.paymentBlock.code}** (${inv.paymentBlock.description}).`
    : `Invoice **${inv.number}** from **${inv.vendorName}** (${fmt(inv.gross)}) has status **${inv.status.replaceAll('_', ' ').toLowerCase()}** and no payment block.`;
  return {
    invoice: {
      number: inv.number,
      fiscalYear: inv.fiscalYear,
      companyCode: inv.companyCode,
      vendor: `${inv.vendorName} (${inv.vendorId})`,
      gross: fmt(inv.gross),
      status: inv.status,
      paymentBlock: inv.paymentBlock,
      dueDate: inv.dueDate,
      purchaseOrder: inv.purchaseOrder,
    },
    summary,
    findings: failed.map((c) => c.message),
    nextSteps: [
      ...(failed.some((c) => c.type === 'QUANTITY') ? ['Confirm whether the outstanding quantity was delivered and post the goods receipt, or request a credit memo.'] : []),
      ...(failed.some((c) => c.type === 'PRICE') ? ['Confirm the agreed price with purchasing; either correct the PO price or request a credit memo for the difference.'] : []),
      ...(inv.paymentBlock ? ['Once the variances are resolved, the block can be released (transaction MRBR or via Prowess with confirmation).'] : []),
    ],
  };
}

export const ficoTools = [
  defineTool({
    name: 'fico_getInvoice',
    domain: 'fico',
    title: 'Get supplier invoice',
    description: 'Retrieve a supplier invoice header, payment block and invoice-verification results from SAP S/4HANA.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving invoice',
    input: { invoiceNumber, fiscalYear: fiscalYear.optional() },
    async run({ invoiceNumber, fiscalYear }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const reasons = (inv.varianceChecks ?? []).filter((c) => !c.withinTolerance).map((c) => c.message);
      return { data: invoiceFacts(inv), components: [invoiceComponent(inv, reasons)], source: invoiceSource(ctx, inv), followUps: invoiceFollowUps(inv) };
    },
  }),

  defineTool({
    name: 'fico_analyzeInvoice',
    domain: 'fico',
    title: 'Analyze invoice block',
    description:
      'Analyze why a supplier invoice is blocked by comparing it with its purchase order and goods receipts. Use for "why is invoice X blocked" questions.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Analyzing invoice against PO and goods receipts',
    input: { invoiceNumber, fiscalYear: fiscalYear.optional() },
    async run({ invoiceNumber, fiscalYear }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const facts = invoiceFacts(inv);
      const components: ToolResultPayload['components'] = [invoiceComponent(inv, facts.findings as string[])];
      if (inv.purchaseOrder) {
        const receipts = await ctx.gateway.getGoodsReceipts(ctx.sap, inv.purchaseOrder).catch(() => []);
        if (receipts.length) {
          components.push({
            type: 'business_object_table',
            data: {
              title: `Goods receipts for PO ${inv.purchaseOrder}`,
              columns: [
                { key: 'doc', label: 'Material document' },
                { key: 'item', label: 'PO item' },
                { key: 'date', label: 'Posted' },
                { key: 'qty', label: 'Quantity', align: 'right' },
              ],
              rows: receipts.map((r) => ({ doc: r.materialDocument, item: r.item, date: r.postingDate, qty: `${r.quantity} ${r.unit}` })),
            },
          });
          facts.goodsReceipts = receipts.map((r) => `${r.materialDocument}: ${r.quantity} ${r.unit} on ${r.postingDate}`);
        }
      }
      return { data: facts, components, source: invoiceSource(ctx, inv), followUps: invoiceFollowUps(inv) };
    },
  }),

  defineTool({
    name: 'fico_getPaymentStatus',
    domain: 'fico',
    title: 'Get payment status',
    description: 'Get whether a supplier invoice is paid, open or blocked, including the clearing document when paid.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking payment status',
    input: { invoiceNumber, fiscalYear: fiscalYear.optional() },
    async run({ invoiceNumber, fiscalYear }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const summary =
        inv.status === 'PAID'
          ? `Invoice **${inv.number}** was paid on **${inv.paidOn}** (payment document ${inv.paymentDocument}).`
          : inv.paymentBlock
            ? `Invoice **${inv.number}** is **not paid**: it is blocked with key ${inv.paymentBlock.code} (${inv.paymentBlock.description}).`
            : `Invoice **${inv.number}** is **open**, due **${inv.dueDate ?? 'n/a'}**. It will be picked up by the next payment run after the due date.`;
      return {
        data: { invoiceNumber: inv.number, status: inv.status, paidOn: inv.paidOn, paymentDocument: inv.paymentDocument, dueDate: inv.dueDate, summary },
        components: [
          {
            type: 'kpi_block',
            data: {
              title: `Payment status · ${inv.number}`,
              items: [
                { label: 'Status', value: inv.status.replaceAll('_', ' '), tone: inv.status === 'PAID' ? 'positive' : inv.paymentBlock ? 'critical' : 'neutral' },
                { label: 'Amount', value: fmt(inv.gross) },
                { label: inv.status === 'PAID' ? 'Paid on' : 'Due', value: (inv.paidOn ?? inv.dueDate ?? 'n/a').slice(0, 20) },
              ],
            },
          },
        ],
        source: invoiceSource(ctx, inv),
      };
    },
  }),

  defineTool({
    name: 'fico_getVendor',
    domain: 'fico',
    title: 'Get vendor financials',
    description: 'Retrieve a supplier master record with open and overdue items (vendor exposure) from SAP.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving vendor exposure',
    input: { vendorId: z.string().regex(/^[A-Z0-9]{1,10}$/i).describe('SAP supplier / business partner number') },
    async run({ vendorId }, ctx) {
      const v = await ctx.gateway.getVendor(ctx.sap, vendorId);
      const summary =
        `**${v.name}** (${v.id}, ${v.city ? `${v.city}, ` : ''}${v.country})` +
        (v.openItems ? ` has open items of **${fmt(v.openItems)}**` : '') +
        (v.overdueItems ? `, of which **${fmt(v.overdueItems)}** are overdue` : '') +
        (v.riskRating ? `. Risk rating: **${v.riskRating}**.` : '.');
      return {
        data: { vendor: v, summary },
        components: [
          {
            type: 'vendor',
            data: {
              id: v.id,
              name: v.name,
              country: v.country,
              ...(v.city && { city: v.city }),
              ...(v.paymentTerms && { paymentTerms: v.paymentTerms }),
              blocked: v.paymentBlocked || v.postingBlocked,
              ...(v.openItems && { openItems: v.openItems }),
              ...(v.overdueItems && { overdueItems: v.overdueItems }),
              ...(v.riskRating && { riskRating: v.riskRating }),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'Supplier', objectId: v.id, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'fico_getGLBalance',
    domain: 'fico',
    title: 'Get G/L account balance',
    description: 'Retrieve debit, credit and balance for a G/L account in a company code and fiscal year.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving G/L balance',
    input: {
      glAccount: z.string().regex(/^\d{6,10}$/),
      companyCode: z.string().regex(/^[A-Z0-9]{4}$/),
      fiscalYear,
      period: z.string().regex(/^\d{3}$/).optional(),
    },
    async run({ glAccount, companyCode, fiscalYear, period }, ctx) {
      const b = await ctx.gateway.getGLBalance(ctx.sap, glAccount, companyCode, fiscalYear, period);
      return {
        data: { balance: b, summary: `G/L account **${b.account}** (${b.description}) in company code ${b.companyCode}, FY ${b.fiscalYear} period ${b.period}: balance **${fmt(b.balance)}**.` },
        components: [{ type: 'gl_balance', data: b }],
        source: { system: ctx.gateway.systemId, objectType: 'GLAccount', objectId: `${b.companyCode}/${b.account}`, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'fico_addInvoiceNote',
    domain: 'fico',
    title: 'Add note to invoice',
    description: 'Attach a short internal note to a supplier invoice. Does not change amounts or status.',
    risk: 'LOW_RISK_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Adding invoice note',
    input: { invoiceNumber, fiscalYear: fiscalYear.optional(), note: z.string().min(1).max(500) },
    async preview({ invoiceNumber, note }) {
      return {
        action: 'Add invoice note',
        businessObject: { type: 'Supplier invoice', id: invoiceNumber },
        proposedChange: `Add note: “${note}”`,
        impact: 'A note is attached to the invoice. Amounts, status and payment block are unchanged.',
      };
    },
    async run({ invoiceNumber, fiscalYear, note }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const res = await ctx.gateway.addInvoiceNote(ctx.sap, inv.number, inv.fiscalYear, note);
      return { data: { noteId: res.noteId, summary: `Added a note to invoice **${inv.number}**.` }, source: invoiceSource(ctx, inv) };
    },
  }),

  defineTool({
    name: 'fico_releaseInvoicePaymentBlock',
    domain: 'fico',
    title: 'Release invoice payment block',
    description:
      'Release the payment block of a blocked supplier invoice so it can be paid. Consequential: always requires explicit user confirmation and SAP release authorization.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Releasing payment block',
    input: { invoiceNumber, fiscalYear: fiscalYear.optional() },
    async preview({ invoiceNumber, fiscalYear }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      return {
        action: 'Release invoice payment block',
        businessObject: { type: 'Supplier invoice', id: `${inv.number}/${inv.fiscalYear}` },
        proposedChange: inv.paymentBlock
          ? `Remove payment block ${inv.paymentBlock.code} (${inv.paymentBlock.description}) from ${fmt(inv.gross)} invoice of ${inv.vendorName}.`
          : 'The invoice currently has no payment block — SAP will reject this action.',
        impact: `The invoice becomes eligible for the next payment run (due ${inv.dueDate ?? 'n/a'}). ${fmt(inv.gross)} may be paid to ${inv.vendorName} even if price/quantity variances remain unresolved.`,
      };
    },
    async run({ invoiceNumber, fiscalYear }, ctx) {
      const current = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const inv = await ctx.gateway.releaseInvoiceBlock(ctx.sap, current.number, current.fiscalYear);
      return {
        data: { summary: `The payment block on invoice **${inv.number}** was released. Status is now **${inv.status}**.`, invoice: { number: inv.number, status: inv.status } },
        components: [invoiceComponent(inv)],
        source: invoiceSource(ctx, inv),
      };
    },
  }),
];
