import { z } from 'zod';
import { SapError } from '../sap/model.js';
import { fiscalYear, invoiceNumber } from './mm-invoice.js';
import { poNumber } from './mm.js';
import { defineTool, fmt, now } from './types.js';

/** MM: reversing a goods receipt (MIGO cancellation) and a supplier invoice (MR8M). */
export const mmReversalTools = [
  defineTool({
    name: 'mm_reverseGoodsReceipt',
    domain: 'mm',
    title: 'Reverse goods receipt',
    description:
      'Reverse the latest goods receipt of a purchase order (MIGO cancellation). The stock is reduced again and the GR/IR posting is reversed. Not possible while the order has a supplier invoice. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Reversing goods receipt',
    input: { purchaseOrder: poNumber },
    async preview({ purchaseOrder }, ctx) {
      const [po, receipts] = await Promise.all([ctx.gateway.getPurchaseOrder(ctx.sap, purchaseOrder), ctx.gateway.getGoodsReceipts(ctx.sap, purchaseOrder)]);
      const last = receipts.at(-1);
      const lines = receipts.filter((r) => r.materialDocument === last?.materialDocument);
      return {
        action: 'Reverse goods receipt',
        businessObject: { type: 'Purchase order', id: po.number },
        proposedChange: last ? `Reverse material document ${last.materialDocument}: ${lines.map((r) => `${r.quantity} ${r.unit}`).join(', ')} received from ${po.vendorName}.` : 'This purchase order has no goods receipt — SAP will reject this action.',
        impact: 'The quantity is taken out of stock again and the posting to the GR/IR clearing account is reversed. The purchase order is open for receipt again.',
      };
    },
    async run({ purchaseOrder }, ctx) {
      const last = (await ctx.gateway.getGoodsReceipts(ctx.sap, purchaseOrder)).at(-1);
      if (!last) throw new SapError('BUSINESS_RULE', `Purchase order ${purchaseOrder} has no goods receipt to reverse.`);
      const r = await ctx.gateway.reverseGoodsReceipt(ctx.sap, last.materialDocument, last.year);
      return {
        data: { summary: `Goods receipt **${r.reversedDocument}** of purchase order **${purchaseOrder}** was reversed with material document **${r.document}**.`, reversalDocument: r.document },
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseOrder', objectId: purchaseOrder, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Purchase order flow', prompt: `Show the document flow for purchase order ${purchaseOrder}.` }],
        outputs: { reversalDocument: r.document },
      };
    },
  }),

  defineTool({
    name: 'mm_reverseSupplierInvoice',
    domain: 'mm',
    title: 'Reverse supplier invoice',
    description: 'Reverse a posted supplier invoice (transaction MR8M). SAP posts a reversal document that removes the payable. Not possible once the invoice is paid. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Reversing supplier invoice',
    input: {
      invoiceNumber,
      fiscalYear: fiscalYear.optional(),
      reason: z.string().regex(/^[A-Z0-9]{2}$/).default('01').describe('SAP reversal reason, e.g. 01 = reversal in current period'),
    },
    async preview({ invoiceNumber, fiscalYear }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      return {
        action: 'Reverse supplier invoice',
        businessObject: { type: 'Supplier invoice', id: `${inv.number}/${inv.fiscalYear}` },
        proposedChange: inv.status === 'PAID' || inv.status === 'REVERSED' ? `This invoice is ${inv.status.toLowerCase()} — SAP will reject the reversal.` : `Reverse the ${fmt(inv.gross)} invoice of ${inv.vendorName}.`,
        impact: `The payable to ${inv.vendorName} is removed and the GR/IR clearing account is posted back${inv.purchaseOrder ? `, so purchase order ${inv.purchaseOrder} can be invoiced again` : ''}.`,
      };
    },
    async run({ invoiceNumber, fiscalYear, reason }, ctx) {
      const inv = await ctx.gateway.getInvoice(ctx.sap, invoiceNumber, fiscalYear);
      const r = await ctx.gateway.reverseSupplierInvoice(ctx.sap, inv.number, inv.fiscalYear, reason);
      return {
        data: { summary: `Supplier invoice **${inv.number}** from **${inv.vendorName}** (${fmt(inv.gross)}) was reversed with document **${r.document}**.`, reversalDocument: r.document },
        source: { system: ctx.gateway.systemId, objectType: 'SupplierInvoice', objectId: `${inv.number}/${inv.fiscalYear}`, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: inv.purchaseOrder ? [{ label: 'Purchase order flow', prompt: `Show the document flow for purchase order ${inv.purchaseOrder}.` }] : [],
        outputs: { reversalDocument: r.document },
      };
    },
  }),
];
