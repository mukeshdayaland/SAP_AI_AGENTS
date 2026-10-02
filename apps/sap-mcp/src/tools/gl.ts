import { z } from 'zod';
import { accountItemsResult, companyCode } from './line-items.js';
import { fiscalYear } from './mm-invoice.js';
import { defineTool, fmt, now } from './types.js';

const glAccount = z.string().regex(/^\d{6,10}$/);

/** FI-GL: account balances, accounting documents and GR/IR clearing-account reconciliation. */
export const glTools = [
  defineTool({
    name: 'gl_getGLBalance',
    domain: 'gl',
    title: 'Get G/L account balance',
    description: 'Retrieve debit, credit and balance for a G/L account in a company code and fiscal year.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving G/L balance',
    input: {
      glAccount,
      companyCode,
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
    name: 'gl_getAccountingDocument',
    domain: 'gl',
    title: 'Get accounting document',
    description:
      'Retrieve an accounting document (journal entry) with its debit and credit lines. Use to check the postings created by a goods issue, billing document, goods receipt, invoice or payment.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving accounting document',
    input: { documentNumber: z.string().regex(/^\d{1,10}$/).describe('Accounting document number, e.g. 1000000001'), companyCode, fiscalYear },
    async run({ documentNumber, companyCode, fiscalYear }, ctx) {
      const d = await ctx.gateway.getAccountingDocument(ctx.sap, companyCode, fiscalYear, documentNumber);
      const difference = d.items.reduce((s, i) => s + i.amount.amount, 0);
      const balanced = Math.abs(difference) < 0.005;
      return {
        data: {
          document: { number: d.number, type: d.documentType, postingDate: d.postingDate, reference: d.reference },
          lines: d.items.map((i) => `${i.debitCredit === 'D' ? 'Debit' : 'Credit'} ${i.account}${i.description ? ` ${i.description}` : ''}: ${fmt({ amount: Math.abs(i.amount.amount), currency: i.amount.currency })}`),
          summary:
            `Accounting document **${d.number}** (type ${d.documentType}, posted ${d.postingDate}) in company code ${d.companyCode} has ${d.items.length} line(s)` +
            (balanced ? ' and balances to zero.' : '.'),
          findings: balanced ? [] : ['The lines shown do not balance to zero: some lines may not be visible with your authorization.'],
        },
        components: [
          {
            type: 'accounting_document',
            data: {
              number: d.number,
              companyCode: d.companyCode,
              fiscalYear: d.fiscalYear,
              documentType: d.documentType,
              postingDate: d.postingDate,
              ...(d.reference && { reference: d.reference }),
              items: d.items.slice(0, 100).map((i) => ({ item: i.item, account: i.account, ...(i.description && { description: i.description }), amount: i.amount, debitCredit: i.debitCredit })),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'AccountingDocument', objectId: `${d.companyCode}/${d.number}/${d.fiscalYear}`, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'gl_listGRIROpenItems',
    domain: 'gl',
    title: 'List open GR/IR items',
    description:
      'List the open items on the goods-receipt / invoice-receipt (GR/IR) clearing account and show which purchase orders do not balance: goods received but not invoiced, or invoiced but not received.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Reconciling the GR/IR clearing account',
    input: { companyCode, glAccount: glAccount.describe('GR/IR clearing account, e.g. 500030') },
    async run({ companyCode, glAccount }, ctx) {
      const query = { accountType: 'GL' as const, account: glAccount, companyCode, status: 'OPEN' as const };
      const items = await ctx.gateway.listOpenItems(ctx.sap, query);
      const result = accountItemsResult(ctx, query, items);

      // The assignment of a GR/IR item is the purchase order; a non-zero balance per order is an open difference.
      const byOrder = new Map<string, number>();
      for (const i of items) byOrder.set(i.assignment ?? 'unassigned', (byOrder.get(i.assignment ?? 'unassigned') ?? 0) + i.amount.amount);
      const currency = items[0]?.amount.currency ?? '';
      const unbalanced = [...byOrder].filter(([, balance]) => Math.abs(balance) >= 0.005);
      return {
        ...result,
        data: {
          ...result.data,
          findings: unbalanced.map(([order, balance]) =>
            balance < 0
              ? `Purchase order ${order}: goods received but not yet invoiced (${fmt({ amount: -balance, currency })}).`
              : `Purchase order ${order}: invoiced but goods not yet received (${fmt({ amount: balance, currency })}).`,
          ),
          nextSteps: [
            ...(items.length && !unbalanced.length ? ['All open items balance per purchase order: run GR/IR clearing (F.13) to clear them.'] : []),
            ...(unbalanced.some(([, b]) => b < 0) ? ['Chase the outstanding supplier invoices, or propose an accrual at period end.'] : []),
            ...(unbalanced.some(([, b]) => b > 0) ? ['Check why the goods receipt is missing before the invoice is paid.'] : []),
          ],
        },
      };
    },
  }),
];
