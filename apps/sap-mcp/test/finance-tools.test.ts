import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { buildRegistry } from '../src/tools/registry.js';
import { BUSINESS_DOMAINS, type ToolResultPayload } from '../src/tools/types.js';

const as = (sub: string) => ({ principal: { sub }, correlationId: 't' }) as unknown as SapCallContext;
const jordan = as('jordan.lee@prowess.example');
const alex = as('alex.morgan@prowess.example');
const sap = () => new MockSapGateway(0);
const registry = buildRegistry(new Set(BUSINESS_DOMAINS));

async function run(gateway: MockSapGateway, ctx: SapCallContext, name: string, args: Record<string, unknown>): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, { sap: ctx, gateway });
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}
const preview = (gateway: MockSapGateway, ctx: SapCallContext, name: string, args: Record<string, unknown>) => registry.get(name)!.preview!(args as never, { sap: ctx, gateway });
const rows = (r: ToolResultPayload, index = 0) => (r.components![index]!.data as { rows: Record<string, unknown>[] }).rows;

describe('finance analysis tools', () => {
  it('finds G/L accounts by a part of their name', async () => {
    const r = await run(sap(), jordan, 'gl_searchGLAccounts', { searchText: 'bank', companyCode: '1030' });
    expect(r.data.summary).toBe('1 G/L account(s) match "bank" in company code 1030.');
    expect(rows(r)).toEqual([{ account: '220002', name: 'Bank outgoing account (assumed)', companyCode: '1030', chart: 'ACGC' }]);
    expect((await run(sap(), jordan, 'gl_searchGLAccounts', { searchText: 'zzz' })).components).toEqual([]);
  });

  it('summarizes G/L activity for a period range', async () => {
    const r = await run(sap(), jordan, 'gl_getAccountActivity', { companyCode: '1030', fiscalYear: '2026', periodFrom: '9', periodTo: '9' });
    expect(r.data.summary).toMatch(/^7 G\/L account\(s\) were posted to in company code 1030, periods 9-9 of 2026/);
    expect(rows(r).find((x) => x.account === '700000')).toMatchObject({ name: 'SALES', credit: 'SAR 5,000', net: 'SAR -5,000' });
    expect((await run(sap(), jordan, 'gl_getAccountActivity', { companyCode: '1030', fiscalYear: '2026', periodFrom: '1', periodTo: '3' })).data.summary).toBe('Nothing was posted in company code 1030, periods 1-3 of 2026.');
  });

  it('ages receivables per customer and payables per supplier', async () => {
    const ar = await run(sap(), jordan, 'ar_getAging', { companyCode: '1030', currency: 'SAR' });
    expect(ar.data.summary).toMatch(/^2 customer\(s\) owe \*\*SAR 98,500\*\* in company code 1030/);
    expect(rows(ar)[0]).toMatchObject({ customer: '7000000011', total: 'SAR 96,000' });

    const ap = await run(sap(), jordan, 'ap_getAging', { companyCode: '1030', keyDate: '2026-10-02' });
    expect(ap.data.summary).toBe('Company code 1030 owes **SAR 1,120** to 1 supplier(s) at 2026-10-02; **SAR 1,120** is overdue.');
    expect((ap.components![0]!.data as { items: { label: string; value: string }[] }).items[1]).toEqual({ label: '1-30 days (1)', value: 'SAR 1,120', tone: 'warning' });
    expect(rows(ap, 1)).toEqual([{ supplier: 'AL-QASSIM (7002200010)', items: 1, overdue: 'SAR 1,120', amount: 'SAR 1,120' }]);
  });

  it('lists supplier invoices with their block and approval state', async () => {
    const r = await run(sap(), jordan, 'ap_listInvoiceApprovals', { companyCode: '1000', onlyBlocked: true });
    expect(r.data.summary).toBe('3 supplier invoice(s) in company code 1000; **1 blocked**.');
    expect(rows(r)).toEqual([expect.objectContaining({ invoice: '5100012345', status: 'Posted, blocked for payment · blocked', approval: 'Waiting for release' })]);
    await expect(run(sap(), jordan, 'ap_listInvoiceApprovals', { companyCode: '3000', onlyBlocked: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('shows what a payment run would pay and what it excludes', async () => {
    const s = sap();
    // A blocked invoice becomes an exception of the proposal.
    await s.postGoodsReceipt(alex, '4200000403');
    await s.createSupplierInvoice(alex, { purchaseOrder: '4200000403', reference: 'VEN004', grossAmount: 3900 });
    const r = await run(s, alex, 'ap_getPaymentRunProposal', { companyCode: '1030' });
    expect(r.data.summary).toBe(
      'Payment proposal for company code 1030: 1 item(s) totalling **SAR 1,120** would be paid, the largest SAR 1,120 to AL-QASSIM. **1 item(s) are excluded** and need attention before the run. The run must be released by a person in SAP.',
    );
    expect(rows(r, 1)).toEqual([expect.objectContaining({ supplier: 'AL-QASSIM (7002200010)', reason: 'Item is blocked for payment (block R)', amount: 'SAR 3,900' })]);
    expect((await run(s, alex, 'ap_getPaymentRunProposal', { companyCode: '1030', paymentRun: 'NONE1' })).data.summary).toBe('There is no payment run proposal in company code 1030 with identification NONE1.');
  });

  it('reports GR/IR cases, credit-blocked orders, bank reconciliation and depreciation', async () => {
    const s = sap();
    expect((await run(s, alex, 'gl_listGRIRCases', { companyCode: '1030' })).data.summary).toBe('No GR/IR balances are open in company code 1030.');
    await s.postGoodsReceipt(alex, '4200000403');
    const grir = await run(s, alex, 'gl_listGRIRCases', { companyCode: '1030' });
    expect(rows(grir)).toEqual([expect.objectContaining({ po: '4200000403 / 10', supplier: 'AL-QASSIM', cause: 'Goods received, invoice missing', balance: 'SAR -3,000' })]);

    const blocked = await run(s, alex, 'credit_listCreditBlockedOrders', {});
    expect(blocked.data.summary).toBe('1 sales order(s) are blocked by the credit check, worth **SAR 140,000**.');
    expect((await run(s, alex, 'credit_listCreditBlockedOrders', { customer: '7000000010' })).components).toEqual([]);

    const bank = await run(s, alex, 'gl_getBankReconciliation', { companyCode: '1030' });
    expect(bank.data.summary).toBe('1 of 2 bank account(s) in company code 1030 are **not reconciled**: ALIN1/OUT01 (1 open item(s), SAR -2,240).');

    const depreciation = await run(s, alex, 'gl_getDepreciationOverview', { companyCode: '1030', fiscalYear: '2026' });
    expect(depreciation.data.summary).toBe('2 fixed asset(s) in company code 1030, fiscal year 2026: depreciation posted **SAR 15,000**, not yet posted **SAR 3,000** in 3 period(s).');
    expect(rows(depreciation, 1)).toHaveLength(3);
  });
});

describe('clearing', () => {
  it('proposes and posts a clearing once a payment offsets the open invoice', async () => {
    const s = sap();
    const before = await run(s, alex, 'ar_proposeClearing', { companyCode: '1030' });
    expect(before.data.summary).toBe('No customer in company code 1030 has open items that offset each other; 2 customer(s) have open items.');
    expect((await preview(s, alex, 'gl_clearOpenItems', { accountType: 'CUSTOMER', partner: '7000000010', companyCode: '1030' })).proposedChange).toMatch(/cannot be cleared: Only debits or only credits are open/);
    await expect(run(s, alex, 'gl_clearOpenItems', { accountType: 'CUSTOMER', partner: '7000000010', companyCode: '1030' })).rejects.toThrow(/cannot be cleared/);

    // An incoming payment of the invoice amount, requested by one user and approved by another.
    const request = await s.createPaymentRequest(jordan, { direction: 'INCOMING', companyCode: '1030', partner: '7000000010', amount: 2500, currency: 'SAR', bankAccount: '220001' });
    await s.approvePaymentRequest(alex, request.id);
    await s.postPaymentRequest(alex, request.id);

    const proposal = await run(s, alex, 'ar_proposeClearing', { companyCode: '1030', partner: '7000000010' });
    expect(proposal.data.summary).toBe('1 of 1 customer(s) with open items in company code 1030 can be cleared: **Local Customer-01** (SAR 2,500).');
    expect(proposal.followUps).toEqual([{ label: 'Clear Local Customer-01', prompt: 'Clear the open items of customer 7000000010 in company code 1030.' }]);
    expect((await preview(s, alex, 'gl_clearOpenItems', { accountType: 'CUSTOMER', partner: '7000000010', companyCode: '1030' })).proposedChange).toBe(
      'Clear 2 open item(s) of Local Customer-01: debits SAR 2,500 against credits SAR 2,500.',
    );

    const cleared = await run(s, alex, 'gl_clearOpenItems', { accountType: 'CUSTOMER', partner: '7000000010', companyCode: '1030' });
    expect(cleared.outputs).toEqual({ clearingDocument: '1600000001' });
    expect(await s.listOpenItems(alex, { accountType: 'CUSTOMER', account: '7000000010', companyCode: '1030', status: 'OPEN' })).toEqual([]);
    await expect(run(s, alex, 'gl_clearOpenItems', { accountType: 'CUSTOMER', partner: '7000000010', companyCode: '1030' })).rejects.toThrow(/has no open items/);
  });

  it('does not offer supplier clearing while only payables are open', async () => {
    const r = await run(sap(), alex, 'ap_proposeClearing', { companyCode: '1030' });
    expect(rows(r)).toEqual([expect.objectContaining({ account: 'AL-QASSIM (7002200010)', result: 'Only debits or only credits are open: nothing to offset.' })]);
  });
});

describe('manual journal entry', () => {
  const lines = [
    { glAccount: '200041', debitCredit: 'D', amount: 750, text: 'Stock write-off' },
    { glAccount: '200040', debitCredit: 'C', amount: 750 },
  ];

  it('posts a balanced entry and shows it in the G/L activity', async () => {
    const s = sap();
    expect((await preview(s, alex, 'gl_postJournalEntry', { companyCode: '1030', currency: 'SAR', lines })).proposedChange).toBe('Post SAR 750: debit 200041 SAR 750; credit 200040 SAR 750.');
    const posted = await run(s, alex, 'gl_postJournalEntry', { companyCode: '1030', currency: 'SAR', postingDate: '2026-10-02', headerText: 'Write-off', lines });
    expect(posted.outputs).toEqual({ accountingDocument: '100000001', fiscalYear: '2026' });
    const journal = await s.getAccountingDocument(alex, '1030', '2026', '100000001');
    expect(journal.items.map((i) => [i.account, i.amount.amount])).toEqual([['200041', 750], ['200040', -750]]);
  });

  it('refuses an unbalanced entry, an unknown account and a company code without authorization', async () => {
    const s = sap();
    const unbalanced = [lines[0]!, { ...lines[1]!, amount: 700 }];
    expect((await preview(s, alex, 'gl_postJournalEntry', { companyCode: '1030', currency: 'SAR', lines: unbalanced })).proposedChange).toMatch(/are not equal — the entry cannot be posted/);
    await expect(run(s, alex, 'gl_postJournalEntry', { companyCode: '1030', currency: 'SAR', lines: unbalanced })).rejects.toThrow(/does not balance: debits SAR 750, credits SAR 700/);
    await expect(run(s, alex, 'gl_postJournalEntry', { companyCode: '1030', currency: 'SAR', lines: [lines[0]!, { ...lines[1]!, glAccount: '999999' }] })).rejects.toThrow(/G\/L account 999999 is not defined/);
    await expect(run(s, alex, 'gl_postJournalEntry', { companyCode: '3000', currency: 'SAR', lines })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
});
