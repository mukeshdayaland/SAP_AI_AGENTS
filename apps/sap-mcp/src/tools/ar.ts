import { abs, accountItemsResult, companyCode, crossAccountResult, itemStatus, partnerNumber, statusOf, sum, today } from './line-items.js';
import { defineTool, fmt, now } from './types.js';

const customer = partnerNumber.describe('SAP customer / business partner number, e.g. 7000000010');

/** FI-AR: customer master, customer line items (FBL5N) and overdue receivables. */
export const arTools = [
  defineTool({
    name: 'ar_getCustomer',
    domain: 'ar',
    title: 'Get customer',
    description: 'Retrieve a customer master record with its blocks. Pass a company code to include open and overdue receivables.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving customer',
    input: { customer, companyCode: companyCode.optional() },
    async run({ customer, companyCode }, ctx) {
      const c = await ctx.gateway.getCustomer(ctx.sap, customer);
      const open = companyCode ? await ctx.gateway.listOpenItems(ctx.sap, { accountType: 'CUSTOMER', account: c.id, companyCode, status: 'OPEN' }) : [];
      const openTotal = sum(open);
      const overdueTotal = sum(open.filter((i) => statusOf(i, today()) === 'OVERDUE'));
      const blocked = c.orderBlocked || c.deliveryBlocked || c.billingBlocked || c.postingBlocked;
      return {
        data: {
          customer: c,
          summary:
            `**${c.name}** (${c.id}${c.city ? `, ${c.city}` : ''}${c.country ? `, ${c.country}` : ''})` +
            (openTotal ? ` has open receivables of **${fmt(openTotal)}**` : companyCode ? ' has no open receivables' : '') +
            (overdueTotal ? `, of which **${fmt(abs(overdueTotal))}** is overdue` : '') +
            `. ${blocked ? 'The customer is **blocked**.' : 'No customer blocks.'}`,
        },
        components: [
          {
            type: 'customer',
            data: {
              id: c.id,
              name: c.name,
              ...(c.country && { country: c.country }),
              ...(c.city && { city: c.city }),
              blocked,
              ...(openTotal && { openItems: openTotal }),
              ...(overdueTotal && { overdueItems: abs(overdueTotal) }),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'Customer', objectId: c.id, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Credit exposure', prompt: `Show the credit exposure of customer ${c.id}.` }],
      };
    },
  }),

  defineTool({
    name: 'ar_listCustomerOpenItems',
    domain: 'ar',
    title: 'List customer line items',
    description:
      'List the line items of a customer account (transaction FBL5N): open items by default, or cleared / all items to verify that a payment cleared an invoice.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving customer line items',
    input: { customer, companyCode, status: itemStatus },
    async run({ customer, companyCode, status }, ctx) {
      const query = { accountType: 'CUSTOMER' as const, account: customer, companyCode, status };
      return accountItemsResult(ctx, query, await ctx.gateway.listOpenItems(ctx.sap, query));
    },
  }),

  defineTool({
    name: 'ar_listOverdueReceivables',
    domain: 'ar',
    title: 'List overdue receivables',
    description: 'List open customer items in a company code that are past their due date, across all customers. Use for collections and dunning priorities.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Finding overdue receivables',
    input: { companyCode },
    async run({ companyCode }, ctx) {
      const asOf = today();
      const items = (await ctx.gateway.listOpenItems(ctx.sap, { accountType: 'CUSTOMER', companyCode, status: 'OPEN', dueBy: asOf })).filter(
        (i) => statusOf(i, asOf) === 'OVERDUE' && i.amount.amount > 0,
      );
      return crossAccountResult(
        ctx,
        {
          title: `Overdue receivables · company code ${companyCode}`,
          partnerLabel: 'Customer',
          objectType: 'OverdueReceivables',
          companyCode,
          empty: `No customer items are overdue in company code ${companyCode}.`,
          headline: (count, total) => `${count} customer item(s) totalling **${total}** are overdue in company code ${companyCode}.`,
        },
        items,
      );
    },
  }),
];
