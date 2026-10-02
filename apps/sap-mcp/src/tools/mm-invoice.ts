import { z } from 'zod';
import type { Invoice } from '../sap/model.js';
import { defineTool, fmt, now, type ToolContext, type ToolResultPayload } from './types.js';

export const invoiceNumber = z.string().regex(/^\d{10}$/, 'SAP invoice numbers have 10 digits').describe('Supplier invoice document number, e.g. 5100012345');
export const fiscalYear = z.string().regex(/^\d{4}$/).describe('Fiscal year, e.g. 2026');

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

export function invoiceSource(ctx: ToolContext, inv: Invoice) {
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

/** MM logistics invoice verification (MIRO / MRBR): supplier invoices, 3-way match and payment blocks. */
export const mmInvoiceTools = [
  defineTool({
    name: 'mm_getInvoice',
    domain: 'mm',
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
    name: 'mm_analyzeInvoice',
    domain: 'mm',
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
    name: 'mm_addInvoiceNote',
    domain: 'mm',
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
    name: 'mm_releaseInvoicePaymentBlock',
    domain: 'mm',
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
