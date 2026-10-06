import { z } from 'zod';
import { accountItemsResult, companyCode, crossAccountResult, itemStatus, partnerNumber, today } from './line-items.js';
import { fiscalYear, invoiceNumber, invoiceSource } from './mm-invoice.js';
import { defineTool, fmt, now } from './types.js';

const supplier = partnerNumber.describe('SAP supplier / business partner number, e.g. 7002200010');

/** FI-AP: supplier exposure, payment status, vendor line items (FBL1N) and payables due for payment. */
export const apTools = [
  defineTool({
    name: 'ap_listVendorAddresses',
    domain: 'ap',
    title: 'List vendor addresses',
    description: 'List every supplier the user may see with its address. Feeds the vendor map; too large for a model, so only the orchestrator calls it.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving vendor addresses',
    internal: true,
    input: {},
    async run(_args, ctx) {
      const vendors = await ctx.gateway.listVendorAddresses(ctx.sap);
      return {
        data: { vendors, summary: `${vendors.length} supplier(s).` },
        source: { system: ctx.gateway.systemId, objectType: 'Supplier', objectId: 'all', retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'ap_showVendorMap',
    domain: 'ap',
    title: 'Show vendors on a map',
    description:
      'Show the suppliers on a map in the chat, optionally only those of one country or city. Use it when the user asks where vendors are, or for a map of vendors or suppliers.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Preparing the vendor map',
    input: {
      country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional().describe('ISO country code, e.g. IN or US'),
      city: z.string().trim().min(2).max(60).optional().describe('City name as written in SAP, e.g. Bangalore'),
    },
    async run({ country, city }, ctx) {
      const iso = country?.toUpperCase();
      const wanted = city?.toLowerCase();
      const vendors = (await ctx.gateway.listVendorAddresses(ctx.sap)).filter((v) => (!iso || v.country === iso) && (!wanted || (v.city ?? '').toLowerCase().includes(wanted)));
      const where = [city, iso].filter(Boolean).join(', ');
      const byCity = new Map<string, number>();
      for (const v of vendors) if (v.city) byCity.set(v.city.toUpperCase(), (byCity.get(v.city.toUpperCase()) ?? 0) + 1);
      const topCities = [...byCity].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ city: name, vendors: count }));
      const withoutAddress = vendors.filter((v) => !v.city && !v.postalCode).length;
      return {
        data: {
          vendors: vendors.length,
          withoutAddress,
          topCities,
          summary: vendors.length
            ? `The map shows the ${vendors.length} supplier(s)${where ? ` in ${where}` : ''}. ${withoutAddress} of them have no usable address in SAP and are left off.`
            : `No suppliers were found${where ? ` in ${where}` : ''}.`,
        },
        components: vendors.length ? [{ type: 'vendor_map', data: { title: where ? `Vendors in ${where}` : 'All vendors', vendors: vendors.length, ...(iso && { country: iso }), ...(city && { city }) } }] : [],
        source: { system: ctx.gateway.systemId, objectType: 'Supplier', objectId: where || 'all', retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'ap_getVendor',
    domain: 'ap',
    title: 'Get vendor financials',
    description: 'Retrieve a supplier master record with open and overdue items (vendor exposure) from SAP.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving vendor exposure',
    input: { vendorId: supplier },
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
    name: 'ap_getPaymentStatus',
    domain: 'ap',
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
    name: 'ap_listVendorOpenItems',
    domain: 'ap',
    title: 'List vendor line items',
    description:
      'List the line items of a supplier account (transaction FBL1N): open items by default, or cleared / all items to verify that a payment cleared an invoice.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving vendor line items',
    input: { supplier, companyCode, status: itemStatus },
    async run({ supplier, companyCode, status }, ctx) {
      const query = { accountType: 'SUPPLIER' as const, account: supplier, companyCode, status };
      return accountItemsResult(ctx, query, await ctx.gateway.listOpenItems(ctx.sap, query));
    },
  }),

  defineTool({
    name: 'ap_listInvoicesDue',
    domain: 'ap',
    title: 'List payables due',
    description: 'List open supplier items in a company code that are due for payment on or before a date (default: today), across all suppliers. Use to prepare a payment run.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Finding payables due for payment',
    input: { companyCode, dueBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due on or before this date, YYYY-MM-DD. Defaults to today.') },
    async run({ companyCode, dueBy }, ctx) {
      const date = dueBy ?? today();
      // Payables are credits on the supplier account; debit items (payments, credit memos) are not due for payment.
      const items = (await ctx.gateway.listOpenItems(ctx.sap, { accountType: 'SUPPLIER', companyCode, status: 'OPEN', dueBy: date })).filter((i) => i.amount.amount < 0);
      const blocked = items.filter((i) => i.paymentBlock).length;
      return crossAccountResult(
        ctx,
        {
          title: `Payables due by ${date} · company code ${companyCode}`,
          partnerLabel: 'Supplier',
          objectType: 'PayablesDue',
          companyCode,
          empty: `No supplier items are due for payment by ${date} in company code ${companyCode}.`,
          headline: (count, total) =>
            `${count} supplier item(s) totalling **${total}** are due for payment by ${date} in company code ${companyCode}${blocked ? `; ${blocked} of them carry a payment block` : ''}.`,
        },
        items,
      );
    },
  }),
];
