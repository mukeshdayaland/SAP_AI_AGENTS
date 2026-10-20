import { z } from 'zod';
import type { PurchaseOrder } from '../sap/model.js';
import { today } from './line-items.js';
import { defineTool, fmt, now, type ToolContext } from './types.js';

/**
 * Checks a supplier invoice, as read from the supplier's document, against its
 * purchase order before it is posted (invoice intake). It reads only; SAP's own
 * three-way match and duplicate check still run when the invoice is posted.
 */

// Not imported from mm.ts, which imports this module for its posting preview.
const poNumber = z.string().regex(/^\d{10}$/).describe('Purchase order number, e.g. 4500012345');
export const invoiceReference = z.string().trim().min(1).max(16).describe("The supplier's own invoice number, e.g. VEN003");
export const invoiceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a valid date')
  .describe('Invoice date as printed on the invoice, YYYY-MM-DD');

export type CheckStatus = 'OK' | 'WARN' | 'STOP';
export interface InvoiceCheck {
  check: string;
  status: CheckStatus;
  message: string;
}

export interface IncomingInvoice {
  purchaseOrder: string;
  reference: string;
  grossAmount: number;
  currency?: string;
  taxAmount?: number;
  invoiceDate?: string;
  supplierName?: string;
}

/** Without a tax amount, gross may exceed the net value received by up to this share (tax) before it is questioned. */
const MAX_TAX_SHARE = 0.25;
/** Net invoiced against net received; S/4HANA's tolerance keys decide at posting. */
const NET_TOLERANCE = 0.02;
const LEGAL_FORMS = new Set(['llc', 'ltd', 'est', 'co', 'company', 'inc', 'gmbh', 'ag', 'sa', 'plc', 'wll', 'fze', 'fzco', 'trading', 'the']);

const normRef = (r: string) => r.toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = (name: string) =>
  name
    .toLowerCase()
    .replace(/[-.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !LEGAL_FORMS.has(w));
const sameSupplier = (a: string, b: string) => {
  const wb = new Set(words(b));
  return words(a).some((w) => wb.has(w));
};
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export async function checkIncomingInvoice(ctx: ToolContext, inv: IncomingInvoice) {
  const po: PurchaseOrder = await ctx.gateway.getPurchaseOrder(ctx.sap, inv.purchaseOrder);
  const [receipts, invoices] = await Promise.all([ctx.gateway.getGoodsReceipts(ctx.sap, po.number), ctx.gateway.getInvoicesForPurchaseOrder(ctx.sap, po.number)]);
  const currency = po.value.currency;
  const money = (amount: number) => fmt({ amount, currency });
  const checks: InvoiceCheck[] = [];
  const add = (check: string, status: CheckStatus, message: string) => checks.push({ check, status, message });

  if (po.status === 'DRAFT' || po.status === 'AWAITING_APPROVAL') add('Purchase order', 'STOP', `Purchase order ${po.number} is not released yet (${po.status.replaceAll('_', ' ').toLowerCase()}).`);
  else if (po.status === 'CLOSED') add('Purchase order', 'STOP', `Purchase order ${po.number} is closed.`);
  else add('Purchase order', 'OK', `Purchase order ${po.number} of ${po.vendorName}, ${fmt(po.value)} net, company code ${po.companyCode}.`);

  if (inv.supplierName) {
    if (sameSupplier(inv.supplierName, po.vendorName)) add('Supplier', 'OK', `"${inv.supplierName}" is the supplier of the order (${po.vendorName}, ${po.vendorId}).`);
    else add('Supplier', 'WARN', `The invoice is from "${inv.supplierName}", but the order is with ${po.vendorName} (${po.vendorId}). Confirm the supplier before posting.`);
  }

  if (inv.currency && inv.currency.toUpperCase() !== currency) add('Currency', 'STOP', `The invoice is in ${inv.currency.toUpperCase()}, the order in ${currency}.`);

  const duplicate = invoices.find((i) => i.reference && normRef(i.reference) === normRef(inv.reference));
  if (duplicate) add('Duplicate', 'STOP', `Invoice ${inv.reference} is already posted as ${duplicate.number}/${duplicate.fiscalYear} (${fmt(duplicate.gross)}, ${duplicate.status.replaceAll('_', ' ').toLowerCase()}).`);
  else if (invoices.length) {
    const invoiced = invoices.reduce((s, i) => s + i.gross.amount, 0);
    add('Duplicate', 'WARN', `The order already has ${invoices.length} invoice(s) for ${money(invoiced)} gross (${invoices.map((i) => i.number).join(', ')}). Make sure this is not the same invoice under another number.`);
  } else add('Duplicate', 'OK', `No invoice is posted for the order yet.`);

  // The value received at the order price, as the invoice is posted; a receipt's own value is used when it is in the order currency.
  const orderPrice = (item: string) => po.items.find((i) => Number(i.item) === Number(item))?.netPrice.amount ?? 0;
  const receivedNet = Math.round(receipts.reduce((s, g) => s + (g.value && g.value.currency === currency ? g.value.amount : g.quantity * orderPrice(g.item)), 0) * 100) / 100;
  if (!receipts.length) add('Goods receipt', 'WARN', `No goods have been received for the order. SAP will post the invoice blocked for payment until they are.`);
  else
    add(
      'Goods receipt',
      receivedNet < po.value.amount ? 'WARN' : 'OK',
      `${money(receivedNet)} net received in ${receipts.length} receipt(s)${receivedNet < po.value.amount ? ` of ${fmt(po.value)} ordered; only the received quantity is invoiced` : ', the full order'}.`,
    );

  if (receivedNet > 0) {
    if (inv.taxAmount !== undefined) {
      const net = inv.grossAmount - inv.taxAmount;
      const off = (net - receivedNet) / receivedNet;
      add('Amount', Math.abs(off) <= NET_TOLERANCE ? 'OK' : 'WARN', `Net ${money(net)} (gross ${money(inv.grossAmount)} less tax ${money(inv.taxAmount)}) against ${money(receivedNet)} received: ${off === 0 ? 'equal' : `${pct(Math.abs(off))} ${off > 0 ? 'more' : 'less'}`}.`);
    } else {
      const share = inv.grossAmount / receivedNet - 1;
      if (share < -NET_TOLERANCE) add('Amount', 'WARN', `Gross ${money(inv.grossAmount)} is less than the ${money(receivedNet)} net received.`);
      else if (share > MAX_TAX_SHARE) add('Amount', 'WARN', `Gross ${money(inv.grossAmount)} is ${pct(share)} above the ${money(receivedNet)} net received, more than tax explains.`);
      else add('Amount', 'OK', `Gross ${money(inv.grossAmount)} against ${money(receivedNet)} net received (${pct(share)} on top, for tax).`);
    }
  }

  if (inv.invoiceDate) {
    const days = (Date.parse(today()) - Date.parse(inv.invoiceDate)) / 86_400_000;
    if (days < 0) add('Invoice date', 'WARN', `The invoice date ${inv.invoiceDate} is in the future.`);
    else if (days > 365) add('Invoice date', 'WARN', `The invoice date ${inv.invoiceDate} is more than a year ago.`);
    else add('Invoice date', 'OK', `Dated ${inv.invoiceDate}.`);
  }

  const verdict = checks.some((c) => c.status === 'STOP') ? 'STOP' : checks.some((c) => c.status === 'WARN') ? 'REVIEW' : 'READY';
  return { po, checks, verdict, receivedNet } as const;
}

const RESULT: Record<CheckStatus, string> = { OK: 'OK', WARN: 'Check', STOP: 'Stop' };

export const mmInvoiceCheckTools = [
  defineTool({
    name: 'mm_checkSupplierInvoice',
    domain: 'mm',
    title: 'Check supplier invoice',
    description:
      "Check a supplier's invoice against its purchase order before it is posted: order status, supplier, currency, duplicates, goods received and amount. Use it with the values printed on the invoice, before mm_createSupplierInvoice. Posts nothing.",
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking the invoice against the order',
    input: {
      purchaseOrder: poNumber,
      reference: invoiceReference,
      grossAmount: z.coerce.number().positive().describe('Total amount due on the invoice, including tax'),
      currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Currency on the invoice, e.g. SAR'),
      taxAmount: z.coerce.number().min(0).optional().describe('Tax amount printed on the invoice'),
      invoiceDate: invoiceDate.optional(),
      supplierName: z.string().trim().min(2).max(120).optional().describe('Supplier name as printed on the invoice'),
    },
    async run(input, ctx) {
      const { po, checks, verdict } = await checkIncomingInvoice(ctx, input);
      const problems = checks.filter((c) => c.status !== 'OK');
      const summary =
        verdict === 'READY'
          ? `Invoice **${input.reference}** matches purchase order **${po.number}** of **${po.vendorName}** and can be posted.`
          : verdict === 'STOP'
            ? `Invoice **${input.reference}** must not be posted against purchase order **${po.number}**: ${problems.filter((c) => c.status === 'STOP').map((c) => c.message).join(' ')}`
            : `Invoice **${input.reference}** for purchase order **${po.number}** of **${po.vendorName}** can be posted, but ${problems.length} point(s) need a look first.`;
      return {
        data: { verdict, summary, checks, purchaseOrder: { number: po.number, supplier: `${po.vendorName} (${po.vendorId})`, companyCode: po.companyCode, net: fmt(po.value) } },
        components: [
          {
            type: 'business_object_table',
            data: {
              title: `Invoice ${input.reference} against PO ${po.number}`,
              columns: [
                { key: 'check', label: 'Check' },
                { key: 'result', label: 'Result' },
                { key: 'detail', label: 'Detail' },
              ],
              rows: checks.map((c) => ({ check: c.check, result: RESULT[c.status], detail: c.message.slice(0, 300) })),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseOrder', objectId: po.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps:
          verdict === 'STOP'
            ? []
            : [{ label: 'Post the invoice', prompt: `Post invoice ${input.reference} for ${input.grossAmount} against purchase order ${po.number}${input.invoiceDate ? `, dated ${input.invoiceDate}` : ''}.` }],
        outputs: { verdict, supplier: po.vendorId, companyCode: po.companyCode },
      };
    },
  }),
];
