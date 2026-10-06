import { z } from 'zod';
import { SapError, type OpenItem } from '../sap/model.js';
import { companyCode, partnerNumber, sum, today } from './line-items.js';
import { fiscalYear } from './mm-invoice.js';
import { defineTool, fmt, now, type ToolContext } from './types.js';

const period = z.string().regex(/^\d{1,3}$/).describe('Fiscal period, e.g. 09');
const currency = z.string().regex(/^[A-Z]{3}$/).default('SAR').describe('Currency, e.g. SAR');
const glAccount = z.string().regex(/^\d{6,10}$/).describe('G/L account number, e.g. 220001');
const money = (amount: number, cur: string) => fmt({ amount, currency: cur });

type Column = { key: string; label: string; align?: 'left' | 'right' };
type Row = Record<string, string | number | null>;

/** Table component, or nothing when there are no rows. */
const table = (title: string, columns: Column[], rows: Row[]) => (rows.length ? [{ type: 'business_object_table' as const, data: { title: title.slice(0, 200), columns, rows: rows.slice(0, 200) } }] : []);
const source = (ctx: ToolContext, objectType: string, objectId: string) => ({ system: ctx.gateway.systemId, objectType, objectId, retrievedAt: now(), mock: ctx.gateway.mock });
const accountLabel = (type: 'CUSTOMER' | 'SUPPLIER') => (type === 'CUSTOMER' ? 'customer' : 'supplier');

/** What clearing the open items of an account would do: only items that offset each other to zero can be cleared. */
function clearingProposal(items: OpenItem[]) {
  const groups = new Map<string, OpenItem[]>();
  for (const i of items) groups.set(i.account, [...(groups.get(i.account) ?? []), i]);
  return [...groups.entries()].map(([account, open]) => {
    const debit = open.filter((i) => i.amount.amount > 0).reduce((total, i) => total + i.amount.amount, 0);
    const credit = open.filter((i) => i.amount.amount < 0).reduce((total, i) => total - i.amount.amount, 0);
    const difference = Math.round((debit - credit) * 100) / 100;
    const cur = open[0]!.amount.currency;
    return {
      account,
      name: open[0]!.accountName,
      items: open.length,
      debit,
      credit,
      difference,
      currency: cur,
      clearable: debit > 0 && credit > 0 && difference === 0,
      reason: !(debit > 0 && credit > 0) ? 'Only debits or only credits are open: nothing to offset.' : difference === 0 ? 'Debits and credits offset each other completely.' : `${money(Math.abs(difference), cur)} would remain open.`,
    };
  });
}

/** Clearing proposal tool for one side of the ledger. Read-only: nothing is cleared. */
function proposeClearingTool(accountType: 'CUSTOMER' | 'SUPPLIER') {
  const label = accountLabel(accountType);
  return defineTool({
    name: accountType === 'CUSTOMER' ? 'ar_proposeClearing' : 'ap_proposeClearing',
    domain: accountType === 'CUSTOMER' ? 'ar' : 'ap',
    title: accountType === 'CUSTOMER' ? 'Propose customer clearing' : 'Propose supplier clearing',
    description: `Find ${label}s whose open items offset each other (for example an invoice and a payment on account) and can therefore be cleared. A proposal only: nothing is cleared in SAP. Clear a ${label} with gl_clearOpenItems.`,
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Preparing clearing proposal',
    input: { companyCode, partner: partnerNumber.optional().describe(`Only this ${label}. Omit for all ${label}s of the company code.`) },
    async run({ companyCode, partner }, ctx) {
      const items = await ctx.gateway.listOpenItems(ctx.sap, { accountType, companyCode, status: 'OPEN', ...(partner && { account: partner }) });
      const groups = clearingProposal(items).sort((a, b) => Number(b.clearable) - Number(a.clearable) || b.debit - a.debit);
      const clearable = groups.filter((g) => g.clearable);
      return {
        data: {
          summary: clearable.length
            ? `${clearable.length} of ${groups.length} ${label}(s) with open items in company code ${companyCode} can be cleared: ${clearable.map((g) => `**${g.name ?? g.account}** (${money(g.debit, g.currency)})`).join(', ')}.`
            : `No ${label} in company code ${companyCode} has open items that offset each other${groups.length ? `; ${groups.length} ${label}(s) have open items.` : '.'}`,
          proposal: groups.map((g) => ({ [label]: g.account, name: g.name, items: g.items, debit: money(g.debit, g.currency), credit: money(g.credit, g.currency), difference: money(g.difference, g.currency), clearable: g.clearable, reason: g.reason })),
        },
        components: table(
          `Clearing proposal · ${label}s · company code ${companyCode}`,
          [
            { key: 'account', label: accountType === 'CUSTOMER' ? 'Customer' : 'Supplier' },
            { key: 'items', label: 'Open items', align: 'right' },
            { key: 'debit', label: 'Debit', align: 'right' },
            { key: 'credit', label: 'Credit', align: 'right' },
            { key: 'difference', label: 'Difference', align: 'right' },
            { key: 'result', label: 'Result' },
          ],
          groups.map((g) => ({ account: g.name ? `${g.name} (${g.account})` : g.account, items: g.items, debit: money(g.debit, g.currency), credit: money(g.credit, g.currency), difference: money(g.difference, g.currency), result: g.clearable ? 'Can be cleared' : g.reason })),
        ),
        source: source(ctx, 'ClearingProposal', `${companyCode}/${accountType}`),
        followUps: clearable.slice(0, 2).map((g) => ({ label: `Clear ${g.name ?? g.account}`, prompt: `Clear the open items of ${label} ${g.account} in company code ${companyCode}.` })),
      };
    },
  });
}

const journalLine = z.object({
  glAccount,
  debitCredit: z.enum(['D', 'C']).describe('D = debit, C = credit'),
  amount: z.coerce.number().positive().max(1_000_000_000),
  costCenter: z.string().regex(/^[A-Z0-9]{1,10}$/i).optional().describe('Cost center, required by SAP for expense accounts'),
  text: z.string().trim().max(50).optional(),
});

function journalTotals(lines: z.infer<typeof journalLine>[]) {
  const debit = lines.filter((l) => l.debitCredit === 'D').reduce((total, l) => total + l.amount, 0);
  const credit = lines.filter((l) => l.debitCredit === 'C').reduce((total, l) => total + l.amount, 0);
  return { debit, credit, balanced: Math.round((debit - credit) * 100) === 0 };
}

/**
 * Finance analysis and closing support for the FICO agent: G/L accounts and activity,
 * receivables and payables aging, payment run proposal, invoice approvals, GR/IR cases,
 * credit-blocked orders, bank reconciliation, depreciation, clearing and manual journal entries.
 */
export const financeTools = [
  defineTool({
    name: 'gl_searchGLAccounts',
    domain: 'gl',
    title: 'Search G/L accounts',
    description: "Find G/L account numbers by a part of the account name, for example 'BANK', 'CASH', 'TAX' or 'SALES'. Use it before asking for a balance when the user names an account instead of a number.",
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Searching G/L accounts',
    input: { searchText: z.string().trim().min(2).max(40).describe("Part of the account name, e.g. 'BANK'"), companyCode: companyCode.optional() },
    async run({ searchText, companyCode }, ctx) {
      const accounts = await ctx.gateway.searchGLAccounts(ctx.sap, searchText, companyCode);
      return {
        data: {
          summary: accounts.length ? `${accounts.length} G/L account(s) match "${searchText}"${companyCode ? ` in company code ${companyCode}` : ''}.` : `No G/L account name contains "${searchText}"${companyCode ? ` in company code ${companyCode}` : ''}.`,
          accounts,
        },
        components: table(
          `G/L accounts matching "${searchText}"`,
          [
            { key: 'account', label: 'G/L account' },
            { key: 'name', label: 'Name' },
            { key: 'companyCode', label: 'Company code' },
            { key: 'chart', label: 'Chart of accounts' },
          ],
          accounts.map((a) => ({ account: a.account, name: a.longName ?? a.name, companyCode: a.companyCode ?? null, chart: a.chartOfAccounts ?? null })),
        ),
        source: source(ctx, 'GLAccountSearch', searchText),
        followUps: accounts.slice(0, 2).map((a) => ({ label: `Balance of ${a.account}`, prompt: `Show the balance of G/L account ${a.account} in company code ${a.companyCode ?? companyCode ?? '1030'} for fiscal year ${today().slice(0, 4)}.` })),
      };
    },
  }),

  defineTool({
    name: 'gl_getAccountActivity',
    domain: 'gl',
    title: 'Get G/L activity by account',
    description:
      'Debit and credit postings per G/L account for a company code and a range of fiscal periods (leading ledger). Use it for profit-and-loss style questions such as revenue or cost of a quarter: Q1 = periods 1-3, Q2 = 4-6, Q3 = 7-9, Q4 = 10-12. It includes balance-sheet accounts and has no product, customer or cost-center breakdown.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Summarizing G/L activity',
    input: { companyCode, fiscalYear, periodFrom: period.optional(), periodTo: period.optional() },
    async run({ companyCode, fiscalYear, periodFrom, periodTo }, ctx) {
      const accounts = await ctx.gateway.getAccountActivity(ctx.sap, companyCode, fiscalYear, periodFrom, periodTo);
      const cur = accounts[0]?.currency ?? '';
      const range = `period${periodFrom || periodTo ? `s ${periodFrom ?? '1'}-${periodTo ?? '16'}` : 's 1-16'} of ${fiscalYear}`;
      const debit = accounts.reduce((total, a) => total + a.debit, 0);
      const credit = accounts.reduce((total, a) => total + a.credit, 0);
      return {
        data: {
          summary: accounts.length
            ? `${accounts.length} G/L account(s) were posted to in company code ${companyCode}, ${range}: debits **${money(debit, cur)}**, credits **${money(credit, cur)}**.`
            : `Nothing was posted in company code ${companyCode}, ${range}.`,
          accounts: accounts.slice(0, 60).map((a) => ({ account: a.account, name: a.name, debit: money(a.debit, a.currency), credit: money(a.credit, a.currency), net: money(a.net, a.currency) })),
        },
        components: table(
          `G/L activity · company code ${companyCode} · ${range}`,
          [
            { key: 'account', label: 'G/L account' },
            { key: 'name', label: 'Name' },
            { key: 'debit', label: 'Debit', align: 'right' },
            { key: 'credit', label: 'Credit', align: 'right' },
            { key: 'net', label: 'Net (debit − credit)', align: 'right' },
          ],
          accounts.map((a) => ({ account: a.account, name: a.name, debit: money(a.debit, a.currency), credit: money(a.credit, a.currency), net: money(a.net, a.currency) })),
        ),
        source: source(ctx, 'GLActivity', `${companyCode}/${fiscalYear}`),
      };
    },
  }),

  defineTool({
    name: 'ar_getAging',
    domain: 'ar',
    title: 'Get receivables aging',
    description: 'Open receivables per customer for a company code, by days overdue: up to 30, 31-60, 61-90 and over 90 days. Use it to see who owes how much for how long.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Aging receivables',
    input: { companyCode, currency },
    async run({ companyCode, currency }, ctx) {
      const rows = await ctx.gateway.getReceivablesAging(ctx.sap, companyCode, currency);
      const total = rows.reduce((t, r) => t + r.total, 0);
      const old = rows.reduce((t, r) => t + r.over90, 0);
      const cur = rows[0]?.currency ?? currency;
      return {
        data: {
          summary: rows.length
            ? `${rows.length} customer(s) owe **${money(total, cur)}** in company code ${companyCode}; **${money(old, cur)}** is more than 90 days overdue.`
            : `No receivables are open in company code ${companyCode}.`,
          customers: rows.slice(0, 60).map((r) => ({ customer: r.customer, total: money(r.total, cur), over90: money(r.over90, cur) })),
        },
        components: table(
          `Receivables aging · company code ${companyCode}`,
          [
            { key: 'customer', label: 'Customer' },
            { key: 'upTo30', label: 'Not due / 1-30', align: 'right' },
            { key: 'd60', label: '31-60', align: 'right' },
            { key: 'd90', label: '61-90', align: 'right' },
            { key: 'over90', label: 'Over 90', align: 'right' },
            { key: 'total', label: 'Total', align: 'right' },
          ],
          rows.map((r) => ({ customer: r.customer, upTo30: money(r.upTo30, cur), d60: money(r.days31to60, cur), d90: money(r.days61to90, cur), over90: money(r.over90, cur), total: money(r.total, cur) })),
        ),
        source: source(ctx, 'ReceivablesAging', companyCode),
        followUps: rows.slice(0, 2).map((r) => ({ label: `Items of ${r.customer}`, prompt: `Show the open items of customer ${r.customer} in company code ${companyCode}.` })),
      };
    },
  }),

  defineTool({
    name: 'ap_getAging',
    domain: 'ap',
    title: 'Get payables aging',
    description: 'Open payables of a company code by days overdue at a key date (not due, 1-30, 31-60, 61-90, over 90), with the totals per supplier.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Aging payables',
    input: { companyCode, keyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Key date YYYY-MM-DD; defaults to today') },
    async run({ companyCode, keyDate }, ctx) {
      const aging = await ctx.gateway.getPayablesAging(ctx.sap, companyCode, keyDate);
      const total = aging.buckets.reduce((t, b) => t + b.amount, 0);
      const overdue = aging.buckets.slice(1).reduce((t, b) => t + b.amount, 0);
      const items = aging.buckets.reduce((t, b) => t + b.items, 0);
      return {
        data: {
          summary: items
            ? `Company code ${companyCode} owes **${money(total, aging.currency)}** to ${aging.suppliers.length} supplier(s) at ${aging.keyDate}; **${money(overdue, aging.currency)}** is overdue.` + (aging.truncated ? ' Not all open items could be read, so the totals are incomplete.' : '')
            : `No payables are open in company code ${companyCode}.`,
          buckets: aging.buckets.map((b) => ({ bucket: b.bucket, amount: money(b.amount, aging.currency), items: b.items })),
          suppliers: aging.suppliers.slice(0, 40).map((s) => ({ supplier: s.supplier, name: s.name, amount: money(s.amount, aging.currency), overdue: money(s.overdue, aging.currency) })),
        },
        components: items
          ? [
              { type: 'kpi_block' as const, data: { title: `Payables aging · company code ${companyCode} · ${aging.keyDate}`, items: aging.buckets.map((b) => ({ label: `${b.bucket} (${b.items})`, value: money(b.amount, aging.currency), tone: b.bucket === 'Not due' || !b.amount ? ('neutral' as const) : b.bucket === 'Over 90 days' ? ('critical' as const) : ('warning' as const) })) } },
              ...table(
                'Payables by supplier',
                [
                  { key: 'supplier', label: 'Supplier' },
                  { key: 'items', label: 'Open items', align: 'right' },
                  { key: 'overdue', label: 'Overdue', align: 'right' },
                  { key: 'amount', label: 'Open amount', align: 'right' },
                ],
                aging.suppliers.map((s) => ({ supplier: s.name ? `${s.name} (${s.supplier})` : s.supplier, items: s.items, overdue: money(s.overdue, aging.currency), amount: money(s.amount, aging.currency) })),
              ),
            ]
          : [],
        source: source(ctx, 'PayablesAging', companyCode),
      };
    },
  }),

  defineTool({
    name: 'ap_listInvoiceApprovals',
    domain: 'ap',
    title: 'List supplier invoices and approvals',
    description: 'List the supplier invoices of a company code with their status, whether they are blocked, and who has to approve them. Use it to find invoices waiting for approval or release.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving supplier invoices',
    input: { companyCode, onlyBlocked: z.coerce.boolean().default(false).describe('Only invoices that are blocked') },
    async run({ companyCode, onlyBlocked }, ctx) {
      const all = await ctx.gateway.listInvoiceApprovals(ctx.sap, companyCode);
      const invoices = onlyBlocked ? all.filter((i) => i.blocked) : all;
      const blocked = all.filter((i) => i.blocked);
      return {
        data: {
          summary: all.length ? `${all.length} supplier invoice(s) in company code ${companyCode}; **${blocked.length} blocked**.` : `No supplier invoices were found in company code ${companyCode}.`,
          invoices: invoices.slice(0, 60).map((i) => ({ invoice: i.invoice, supplier: i.supplierName, gross: fmt(i.gross), status: i.status, blocked: i.blocked, approvalStatus: i.approvalStatus, approver: i.approver })),
        },
        components: table(
          `Supplier invoices · company code ${companyCode}${onlyBlocked ? ' · blocked' : ''}`,
          [
            { key: 'invoice', label: 'Invoice' },
            { key: 'supplier', label: 'Supplier' },
            { key: 'status', label: 'Status' },
            { key: 'approval', label: 'Approval' },
            { key: 'approver', label: 'Approver' },
            { key: 'gross', label: 'Gross amount', align: 'right' },
          ],
          invoices.map((i) => ({ invoice: i.invoice, supplier: i.supplierName, status: i.blocked ? `${i.status || 'Posted'} · blocked` : i.status, approval: i.approvalStatus ?? null, approver: i.approver ?? null, gross: fmt(i.gross) })),
        ),
        source: source(ctx, 'SupplierInvoiceList', companyCode),
        followUps: blocked.slice(0, 2).map((i) => ({ label: `Analyze ${i.invoice}`, prompt: `Why is invoice ${i.invoice} blocked?` })),
      };
    },
  }),

  defineTool({
    name: 'ap_getPaymentRunProposal',
    domain: 'ap',
    title: 'Get payment run proposal',
    description:
      'Show the payment run (F110) proposal of a company code: the runs, the supplier items that would be paid, and the items SAP excluded with the reason. For review only: releasing a payment run moves money and is done by a person in SAP, never by this assistant.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving payment run proposal',
    input: { companyCode, paymentRun: z.string().regex(/^[A-Z0-9]{1,6}$/i).optional().describe('Payment run identification. Omit for all runs.') },
    async run({ companyCode, paymentRun }, ctx) {
      const p = await ctx.gateway.getPaymentRunProposal(ctx.sap, companyCode, paymentRun);
      const total = sum(p.items.map((i) => ({ amount: i.amount }) as OpenItem));
      const largest = [...p.items].sort((a, b) => b.amount.amount - a.amount.amount)[0];
      return {
        data: {
          summary: !p.runs.length && !p.items.length && !p.exceptions.length
            ? `There is no payment run proposal in company code ${companyCode}${paymentRun ? ` with identification ${paymentRun}` : ''}.`
            : `Payment proposal for company code ${companyCode}: ${p.items.length} item(s)${total ? ` totalling **${fmt(total)}**` : ''} would be paid` +
              (largest ? `, the largest ${fmt(largest.amount)} to ${largest.supplierName ?? largest.supplier}` : '') +
              `. **${p.exceptions.length} item(s) are excluded**${p.exceptions.length ? ' and need attention before the run' : ''}. The run must be released by a person in SAP.`,
          runs: p.runs.map((r) => ({ run: r.runId, date: r.runDate, proposal: r.isProposal, amount: fmt(r.amount) })),
          exceptions: p.exceptions.slice(0, 40).map((e) => ({ supplier: e.supplierName ?? e.supplier, document: e.document, reason: e.message, block: e.blockingReason, amount: fmt(e.amount) })),
        },
        components: [
          ...table(
            `Payment proposal · items to be paid · company code ${companyCode}`,
            [
              { key: 'run', label: 'Run' },
              { key: 'supplier', label: 'Supplier' },
              { key: 'document', label: 'Document' },
              { key: 'method', label: 'Method' },
              { key: 'amount', label: 'Amount', align: 'right' },
            ],
            p.items.map((i) => ({ run: i.runId, supplier: i.supplierName ? `${i.supplierName} (${i.supplier})` : i.supplier, document: i.document, method: i.paymentMethod ?? null, amount: fmt(i.amount) })),
          ),
          ...table(
            'Excluded from the payment run',
            [
              { key: 'supplier', label: 'Supplier' },
              { key: 'document', label: 'Document' },
              { key: 'reason', label: 'Reason' },
              { key: 'amount', label: 'Amount', align: 'right' },
            ],
            p.exceptions.map((e) => ({ supplier: e.supplierName ? `${e.supplierName} (${e.supplier})` : e.supplier, document: e.document, reason: `${e.message}${e.blockingReason ? ` (block ${e.blockingReason})` : ''}`.slice(0, 300), amount: fmt(e.amount) })),
          ),
        ],
        source: source(ctx, 'PaymentRunProposal', `${companyCode}${paymentRun ? `/${paymentRun}` : ''}`),
      };
    },
  }),

  defineTool({
    name: 'gl_listGRIRCases',
    domain: 'gl',
    title: 'List GR/IR cases',
    description: 'List purchase order items with an open balance on the GR/IR clearing account of a company code, with status, priority and root cause from the SAP GR/IR monitor. Use it to find goods received but not invoiced, or invoices without goods receipt.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving GR/IR cases',
    input: { companyCode, fiscalYear: fiscalYear.optional() },
    async run({ companyCode, fiscalYear }, ctx) {
      const cases = (await ctx.gateway.listGRIRCases(ctx.sap, companyCode, fiscalYear)).sort((a, b) => Math.abs(b.balance.amount) - Math.abs(a.balance.amount));
      const cur = cases[0]?.balance.currency ?? '';
      return {
        data: {
          summary: cases.length
            ? `${cases.length} purchase order item(s) have an open GR/IR balance in company code ${companyCode}, **${money(cases.reduce((t, c) => t + Math.abs(c.balance.amount), 0), cur)}** in total.`
            : `No GR/IR balances are open in company code ${companyCode}.`,
          cases: cases.slice(0, 60).map((c) => ({ purchaseOrder: c.purchaseOrder, item: c.item, supplier: c.supplierName ?? c.supplier, balance: fmt(c.balance), rootCause: c.rootCause, status: c.status, dueDays: c.dueDays })),
        },
        components: table(
          `GR/IR cases · company code ${companyCode}`,
          [
            { key: 'po', label: 'Purchase order' },
            { key: 'supplier', label: 'Supplier' },
            { key: 'cause', label: 'Root cause' },
            { key: 'status', label: 'Status' },
            { key: 'days', label: 'Days open', align: 'right' },
            { key: 'balance', label: 'Balance', align: 'right' },
          ],
          cases.map((c) => ({ po: `${c.purchaseOrder} / ${c.item}`, supplier: c.supplierName ?? c.supplier, cause: c.rootCause ?? null, status: [c.status, c.priority].filter(Boolean).join(' · ') || null, days: c.dueDays ?? null, balance: fmt(c.balance) })),
        ),
        source: source(ctx, 'GRIRCases', companyCode),
        followUps: cases.slice(0, 2).map((c) => ({ label: `Flow of ${c.purchaseOrder}`, prompt: `Show the document flow for purchase order ${c.purchaseOrder}.` })),
      };
    },
  }),

  defineTool({
    name: 'credit_listCreditBlockedOrders',
    domain: 'credit',
    title: 'List credit-blocked sales orders',
    description: 'List the sales orders that are blocked by the credit check, optionally for one customer.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Finding credit-blocked orders',
    input: { customer: partnerNumber.optional().describe('Only orders of this customer') },
    async run({ customer }, ctx) {
      const orders = await ctx.gateway.listCreditBlockedOrders(ctx.sap, customer);
      const total = sum(orders.map((o) => ({ amount: o.netValue }) as OpenItem));
      return {
        data: {
          summary: orders.length ? `${orders.length} sales order(s)${customer ? ` of customer ${customer}` : ''} are blocked by the credit check${total ? `, worth **${fmt(total)}**` : ''}.` : `No sales orders${customer ? ` of customer ${customer}` : ''} are blocked by the credit check.`,
          orders: orders.slice(0, 60).map((o) => ({ salesOrder: o.number, customer: o.soldToName, netValue: fmt(o.netValue) })),
        },
        components: table(
          'Credit-blocked sales orders',
          [
            { key: 'order', label: 'Sales order' },
            { key: 'customer', label: 'Customer' },
            { key: 'reference', label: 'Customer reference' },
            { key: 'value', label: 'Net value', align: 'right' },
          ],
          orders.map((o) => ({ order: o.number, customer: o.soldToName === o.soldTo ? o.soldTo : `${o.soldToName} (${o.soldTo})`, reference: o.customerReference ?? null, value: fmt(o.netValue) })),
        ),
        source: source(ctx, 'CreditBlockedOrders', customer ?? 'all'),
        followUps: orders.slice(0, 2).map((o) => ({ label: `Credit of ${o.soldTo}`, prompt: `Show the credit exposure of customer ${o.soldTo}.` })),
      };
    },
  }),

  defineTool({
    name: 'gl_getBankReconciliation',
    domain: 'gl',
    title: 'Get bank reconciliation status',
    description: 'Show, per house bank account of a company code, how many bank statement items are still open on the bank clearing account and their balance. An account without open items is reconciled.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking bank reconciliation',
    input: { companyCode },
    async run({ companyCode }, ctx) {
      const accounts = await ctx.gateway.getBankReconciliation(ctx.sap, companyCode);
      const open = accounts.filter((a) => a.openItems > 0);
      return {
        data: {
          summary: !accounts.length
            ? `No house bank accounts were found for company code ${companyCode}.`
            : open.length
              ? `${open.length} of ${accounts.length} bank account(s) in company code ${companyCode} are **not reconciled**: ${open.map((a) => `${a.houseBank}/${a.houseBankAccount} (${a.openItems} open item(s), ${fmt(a.openBalance)})`).join(', ')}.`
              : `All ${accounts.length} bank account(s) in company code ${companyCode} are reconciled.`,
          accounts: accounts.map((a) => ({ houseBank: a.houseBank, account: a.houseBankAccount, glAccount: a.glAccount, openItems: a.openItems, openBalance: fmt(a.openBalance) })),
        },
        components: table(
          `Bank reconciliation · company code ${companyCode}`,
          [
            { key: 'bank', label: 'House bank / account' },
            { key: 'gl', label: 'G/L account' },
            { key: 'status', label: 'Status' },
            { key: 'items', label: 'Open items', align: 'right' },
            { key: 'balance', label: 'Open balance', align: 'right' },
          ],
          accounts.map((a) => ({ bank: `${a.houseBank} / ${a.houseBankAccount}`, gl: a.glAccountName ? `${a.glAccount} · ${a.glAccountName}` : a.glAccount, status: a.openItems ? 'Not reconciled' : 'Reconciled', items: a.openItems, balance: fmt(a.openBalance) })),
        ),
        source: source(ctx, 'BankReconciliation', companyCode),
      };
    },
  }),

  defineTool({
    name: 'gl_getDepreciationOverview',
    domain: 'gl',
    title: 'Get depreciation overview',
    description: 'Posted and not yet posted depreciation per fixed asset of a company code for a fiscal year, with the net book value and the periods whose depreciation has not been posted. The depreciation run itself (AFAB) is a job in SAP and is not started here.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving depreciation',
    input: { companyCode, fiscalYear },
    async run({ companyCode, fiscalYear }, ctx) {
      const d = await ctx.gateway.getDepreciationOverview(ctx.sap, companyCode, fiscalYear);
      const cur = d.assets[0]?.currency ?? '';
      const posted = d.assets.reduce((t, a) => t + a.posted, 0);
      const unposted = d.assets.reduce((t, a) => t + a.unposted, 0);
      return {
        data: {
          summary: d.assets.length
            ? `${d.assets.length} fixed asset(s) in company code ${companyCode}, fiscal year ${fiscalYear}: depreciation posted **${money(posted, cur)}**, not yet posted **${money(unposted, cur)}** in ${d.exceptions.length} period(s).` +
              (d.truncated ? ' Only the first assets of the company code were examined.' : '')
            : `No fixed assets with depreciation were found in company code ${companyCode} for fiscal year ${fiscalYear}.`,
          assets: d.assets.map((a) => ({ asset: a.asset, description: a.description, posted: money(a.posted, a.currency), unposted: money(a.unposted, a.currency), netBookValue: money(a.netBookValue, a.currency) })),
          unpostedPeriods: d.exceptions.slice(0, 60),
        },
        components: [
          ...table(
            `Depreciation · company code ${companyCode} · ${fiscalYear}`,
            [
              { key: 'asset', label: 'Asset' },
              { key: 'description', label: 'Description' },
              { key: 'posted', label: 'Posted', align: 'right' },
              { key: 'unposted', label: 'Not posted', align: 'right' },
              { key: 'nbv', label: 'Net book value', align: 'right' },
            ],
            d.assets.map((a) => ({ asset: a.asset, description: a.description, posted: money(a.posted, a.currency), unposted: money(a.unposted, a.currency), nbv: money(a.netBookValue, a.currency) })),
          ),
          ...table(
            'Periods without posted depreciation',
            [
              { key: 'asset', label: 'Asset' },
              { key: 'period', label: 'Period' },
              { key: 'status', label: 'Status' },
              { key: 'amount', label: 'Amount', align: 'right' },
            ],
            d.exceptions.map((e) => ({ asset: e.asset, period: e.period, status: e.status, amount: money(e.amount, e.currency) })),
          ),
        ],
        source: source(ctx, 'Depreciation', `${companyCode}/${fiscalYear}`),
      };
    },
  }),

  proposeClearingTool('CUSTOMER'),
  proposeClearingTool('SUPPLIER'),

  defineTool({
    name: 'gl_clearOpenItems',
    domain: 'gl',
    title: 'Clear open items',
    description:
      'Clear the open items of one customer or supplier against each other, for example an invoice against a payment on account (transactions F-32 / F-44). Only possible when the open items of the account offset each other to zero. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Clearing open items',
    input: { accountType: z.enum(['CUSTOMER', 'SUPPLIER']), partner: partnerNumber.describe('Customer or supplier number'), companyCode },
    async preview({ accountType, partner, companyCode }, ctx) {
      const items = await ctx.gateway.listOpenItems(ctx.sap, { accountType, account: partner, companyCode, status: 'OPEN' });
      const group = clearingProposal(items)[0];
      return {
        action: 'Clear open items',
        businessObject: { type: accountType === 'CUSTOMER' ? 'Customer' : 'Supplier', id: partner },
        proposedChange: !group
          ? `This ${accountLabel(accountType)} has no open items — SAP will reject the clearing.`
          : group.clearable
            ? `Clear ${group.items} open item(s) of ${group.name ?? partner}: debits ${money(group.debit, group.currency)} against credits ${money(group.credit, group.currency)}.`
            : `The open items of ${group.name ?? partner} cannot be cleared: ${group.reason}`,
        impact: 'SAP posts a clearing document and the items no longer appear as open. Undoing it requires resetting the clearing in SAP (FBRA).',
      };
    },
    async run({ accountType, partner, companyCode }, ctx) {
      // The items are read again at execution: only a group that still nets to zero is cleared.
      const group = clearingProposal(await ctx.gateway.listOpenItems(ctx.sap, { accountType, account: partner, companyCode, status: 'OPEN' }))[0];
      if (!group) throw new SapError('BUSINESS_RULE', `${accountType === 'CUSTOMER' ? 'Customer' : 'Supplier'} ${partner} has no open items in company code ${companyCode}.`);
      if (!group.clearable) throw new SapError('BUSINESS_RULE', `The open items of ${accountLabel(accountType)} ${partner} cannot be cleared: ${group.reason}`);
      const doc = await ctx.gateway.clearOpenItems(ctx.sap, { accountType, account: partner, companyCode });
      return {
        data: { summary: `${group.items} open item(s) of ${accountLabel(accountType)} **${group.name ?? partner}** (${money(group.debit, group.currency)}) were cleared with document **${doc.document}**.`, clearingDocument: doc.document },
        source: source(ctx, 'ClearingDocument', doc.document),
        followUps: [{ label: 'Account line items', prompt: `Show all line items of ${accountLabel(accountType)} ${partner} in company code ${companyCode}.` }],
        outputs: { clearingDocument: doc.document },
      };
    },
  }),

  defineTool({
    name: 'gl_postJournalEntry',
    domain: 'gl',
    title: 'Post journal entry',
    description:
      'Post a manual G/L journal entry with balanced debit and credit lines (transaction FB50). Only G/L accounts, no customer or supplier lines. Use gl_searchGLAccounts to find account numbers. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Posting journal entry',
    input: {
      companyCode,
      currency,
      postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Posting date YYYY-MM-DD; defaults to today'),
      headerText: z.string().trim().min(1).max(25).optional(),
      lines: z.array(journalLine).min(2).max(20),
    },
    async preview({ companyCode, currency, lines }) {
      const totals = journalTotals(lines);
      const text = (dc: 'D' | 'C') => lines.filter((l) => l.debitCredit === dc).map((l) => `${l.glAccount} ${money(l.amount, currency)}`).join(', ');
      return {
        action: 'Post journal entry',
        businessObject: { type: 'Company code', id: companyCode },
        proposedChange: totals.balanced
          ? `Post ${money(totals.debit, currency)}: debit ${text('D')}; credit ${text('C')}.`
          : `Debits (${money(totals.debit, currency)}) and credits (${money(totals.credit, currency)}) are not equal — the entry cannot be posted.`,
        impact: `An accounting document is posted in company code ${companyCode} and changes the balances of these accounts. Undoing it requires a reversal document (FB08).`,
      };
    },
    async run({ companyCode, currency, postingDate, headerText, lines }, ctx) {
      const totals = journalTotals(lines);
      if (!totals.balanced) throw new SapError('BUSINESS_RULE', `The journal entry does not balance: debits ${money(totals.debit, currency)}, credits ${money(totals.credit, currency)}.`);
      const doc = await ctx.gateway.postJournalEntry(ctx.sap, {
        companyCode,
        currency,
        ...(postingDate && { postingDate }),
        ...(headerText && { headerText }),
        lines: lines.map((l) => ({ glAccount: l.glAccount, debitCredit: l.debitCredit, amount: l.amount, ...(l.costCenter && { costCenter: l.costCenter }), ...(l.text && { text: l.text }) })),
      });
      return {
        data: { summary: `Journal entry **${doc.document}** over **${money(totals.debit, currency)}** was posted in company code ${doc.companyCode}.`, accountingDocument: doc.document },
        source: source(ctx, 'AccountingDocument', `${doc.companyCode}/${doc.fiscalYear ?? ''}/${doc.document}`),
        followUps: doc.fiscalYear ? [{ label: 'Show the document', prompt: `Show accounting document ${doc.document} in company code ${doc.companyCode} for ${doc.fiscalYear}.` }] : [],
        outputs: { accountingDocument: doc.document, ...(doc.fiscalYear && { fiscalYear: doc.fiscalYear }) },
      };
    },
  }),
];
