import { z } from 'zod';
import type { Amount, OpenItem, OpenItemQuery } from '../sap/model.js';
import { fmt, now, type ToolContext, type ToolResultPayload } from './types.js';

/** Input schemas and result builders shared by the AR, AP and G/L line-item tools. */

export const companyCode = z.string().regex(/^[A-Z0-9]{4}$/).describe('Company code, e.g. 1030');
export const partnerNumber = z.string().regex(/^[A-Z0-9]{1,10}$/i);
export const itemStatus = z.enum(['OPEN', 'CLEARED', 'ALL']).default('OPEN').describe('OPEN = not yet cleared (default), CLEARED, or ALL');

export const today = () => now().slice(0, 10);

export type LineItemStatus = 'OPEN' | 'OVERDUE' | 'CLEARED';

export function statusOf(item: OpenItem, asOf = today()): LineItemStatus {
  if (item.clearingDocument) return 'CLEARED';
  return item.dueDate && item.dueDate < asOf ? 'OVERDUE' : 'OPEN';
}

export function sum(items: OpenItem[]): Amount | undefined {
  const currency = items[0]?.amount.currency;
  return currency ? { amount: items.reduce((s, i) => s + i.amount.amount, 0), currency } : undefined;
}

/** Magnitude of a signed total, for sentences such as "owes SAR 2,500". */
export const abs = (m: Amount): Amount => ({ amount: Math.abs(m.amount), currency: m.currency });

const LABEL = { CUSTOMER: 'Customer', SUPPLIER: 'Supplier', GL: 'G/L account' } as const;

/** Result for the line items of one account: an `open_items` card plus facts for the model. */
export function accountItemsResult(ctx: ToolContext, query: OpenItemQuery & { account: string }, items: OpenItem[]): ToolResultPayload {
  const asOf = today();
  const name = items[0]?.accountName;
  const label = `${LABEL[query.accountType]} **${name ? `${name} (${query.account})` : query.account}**`;
  const open = items.filter((i) => !i.clearingDocument);
  const overdue = open.filter((i) => statusOf(i, asOf) === 'OVERDUE');
  const total = sum(items);
  const openTotal = sum(open);
  const overdueTotal = sum(overdue);
  const scope = query.status === 'ALL' ? 'line' : query.status.toLowerCase();

  const summary = !total
    ? `${label} has no ${scope} items in company code ${query.companyCode}.`
    : `${label} has ${items.length} ${scope} item(s) in company code ${query.companyCode}` +
      (openTotal ? `; open balance **${fmt(openTotal)}**` : '; nothing is open') +
      (overdueTotal ? `, of which **${fmt(abs(overdueTotal))}** is overdue.` : '.');

  return {
    data: {
      summary,
      account: query.account,
      companyCode: query.companyCode,
      openBalance: openTotal ? fmt(openTotal) : 'none',
      overdue: overdueTotal ? fmt(abs(overdueTotal)) : 'none',
      items: items.map((i) => ({
        document: i.document,
        type: i.documentType,
        postingDate: i.postingDate,
        dueDate: i.dueDate,
        amount: fmt(i.amount),
        status: statusOf(i, asOf),
        clearingDocument: i.clearingDocument,
        assignment: i.assignment,
      })),
    },
    components: total
      ? [
          {
            type: 'open_items',
            data: {
              accountType: query.accountType,
              account: query.account,
              ...(name && { accountName: name }),
              companyCode: query.companyCode,
              total,
              ...(overdueTotal && { overdue: abs(overdueTotal) }),
              items: items.slice(0, 200).map((i) => ({
                document: i.document,
                documentType: i.documentType,
                postingDate: i.postingDate,
                ...(i.dueDate && { dueDate: i.dueDate }),
                amount: i.amount,
                status: statusOf(i, asOf),
                ...(i.clearingDocument && { clearingDocument: i.clearingDocument }),
                ...((i.text ?? i.assignment) && { text: (i.text ?? i.assignment)!.slice(0, 120) }),
              })),
            },
          },
        ]
      : [],
    source: { system: ctx.gateway.systemId, objectType: `${LABEL[query.accountType].replace(/\W/g, '')}LineItems`, objectId: `${query.companyCode}/${query.account}`, retrievedAt: now(), mock: ctx.gateway.mock },
  };
}

/** Result for items across many accounts (monitoring lists): a table grouped by nothing, sorted by due date. */
export function crossAccountResult(
  ctx: ToolContext,
  opts: { title: string; partnerLabel: string; objectType: string; companyCode: string; empty: string; headline: (count: number, total: string) => string },
  items: OpenItem[],
): ToolResultPayload {
  const sorted = [...items].sort((a, b) => (a.dueDate ?? a.postingDate).localeCompare(b.dueDate ?? b.postingDate));
  const total = sum(sorted);
  const asOf = today();
  return {
    data: {
      summary: total ? opts.headline(sorted.length, fmt(abs(total))) : opts.empty,
      items: sorted.map((i) => ({ account: i.account, name: i.accountName, document: i.document, dueDate: i.dueDate, amount: fmt(i.amount), status: statusOf(i, asOf) })),
    },
    components: total
      ? [
          {
            type: 'business_object_table',
            data: {
              title: opts.title,
              columns: [
                { key: 'account', label: opts.partnerLabel },
                { key: 'document', label: 'Document' },
                { key: 'due', label: 'Due' },
                { key: 'amount', label: 'Amount', align: 'right' },
                { key: 'status', label: 'Status' },
              ],
              rows: sorted.slice(0, 200).map((i) => ({
                account: i.accountName ? `${i.accountName} (${i.account})` : i.account,
                document: i.document,
                due: i.dueDate ?? null,
                amount: fmt(abs(i.amount)),
                status: statusOf(i, asOf).toLowerCase(),
              })),
            },
          },
        ]
      : [],
    source: { system: ctx.gateway.systemId, objectType: opts.objectType, objectId: opts.companyCode, retrievedAt: now(), mock: ctx.gateway.mock },
  };
}
