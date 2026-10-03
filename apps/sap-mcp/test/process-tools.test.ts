import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { buildRegistry } from '../src/tools/registry.js';
import { BUSINESS_DOMAINS, type ToolResultPayload } from '../src/tools/types.js';

const as = (sub: string) => ({ principal: { sub }, correlationId: 't' }) as unknown as SapCallContext;
const jordan = as('jordan.lee@prowess.example'); // no release authorizations in SAP
const alex = as('alex.morgan@prowess.example'); // may release invoices and credit blocks
const sap = () => new MockSapGateway(0);
const registry = buildRegistry(new Set(BUSINESS_DOMAINS));

/** Runs a tool the way the MCP server does, without the HTTP layer and its confirmation token. */
async function run(gateway: MockSapGateway, ctx: SapCallContext, name: string, args: Record<string, unknown>): Promise<ToolResultPayload> {
  const tool = registry.get(name)!;
  const result = await tool.run(args as never, { sap: ctx, gateway });
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}
const preview = (gateway: MockSapGateway, ctx: SapCallContext, name: string, args: Record<string, unknown>) => registry.get(name)!.preview!(args as never, { sap: ctx, gateway });
const openTotal = async (s: MockSapGateway, accountType: 'CUSTOMER' | 'SUPPLIER', account: string) =>
  (await s.listOpenItems(alex, { accountType, account, companyCode: '1030', status: 'OPEN' })).reduce((sum, i) => sum + i.amount.amount, 0);

describe('payment requests', () => {
  const incoming = { direction: 'INCOMING' as const, companyCode: '1030', partner: '7000000010', amount: 2500, currency: 'SAR', bankAccount: '220001', reference: 'BANK-0001' };

  it('needs a second person to approve before an incoming payment can be posted', async () => {
    const s = sap();
    const request = await s.createPaymentRequest(jordan, incoming);
    expect(request).toMatchObject({ status: 'NEW', partnerName: 'Local Customer-01', createdBy: 'jordan.lee@prowess.example' });
    await expect(s.postPaymentRequest(jordan, request.id)).rejects.toThrow(/only an approved request can be posted/);
    await expect(s.approvePaymentRequest(jordan, request.id)).rejects.toThrow(/second person must approve/);

    expect(await s.approvePaymentRequest(alex, request.id)).toMatchObject({ status: 'APPROVED', approvedBy: 'alex.morgan@prowess.example' });
    const posted = await s.postPaymentRequest(jordan, request.id);
    expect(posted).toMatchObject({ status: 'POSTED', accountingDocument: '5000007' });

    // Debit bank, credit customer; the payment sits on the account against the open receivable of SAR 2,500.
    const journal = await s.getAccountingDocument(alex, '1030', posted.fiscalYear!, '5000007');
    expect(journal.items.map((i) => [i.account, i.amount.amount, i.debitCredit])).toEqual([['220001', 2500, 'D'], ['7000000010', -2500, 'C']]);
    expect(journal.documentType).toBe('DZ');
    expect(await openTotal(s, 'CUSTOMER', '7000000010')).toBe(0);

    await expect(s.postPaymentRequest(alex, request.id)).rejects.toThrow(/posted/);
    await expect(s.rejectPaymentRequest(alex, request.id)).rejects.toThrow(/can no longer be rejected/);
  });

  it('posts an outgoing payment to the supplier account', async () => {
    const s = sap();
    const request = await s.createPaymentRequest(jordan, { direction: 'OUTGOING', companyCode: '1030', partner: '7002200010', amount: 1120, currency: 'SAR', bankAccount: '220002' });
    await s.approvePaymentRequest(alex, request.id);
    const posted = await s.postPaymentRequest(alex, request.id);
    expect(posted.accountingDocument).toBe('3000008');
    expect((await s.getAccountingDocument(alex, '1030', posted.fiscalYear!, '3000008')).documentType).toBe('KZ');
    expect(await openTotal(s, 'SUPPLIER', '7002200010')).toBe(0);
  });

  it('closes a rejected request and refuses unknown partners and company codes', async () => {
    const s = sap();
    const request = await s.createPaymentRequest(jordan, incoming);
    expect((await s.rejectPaymentRequest(alex, request.id)).status).toBe('REJECTED');
    await expect(s.approvePaymentRequest(alex, request.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    await expect(s.createPaymentRequest(jordan, { ...incoming, partner: '9999999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.createPaymentRequest(jordan, { ...incoming, companyCode: '3000' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(s.getPaymentRequest(jordan, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('offers the request, the approval queue and the posting as tools', async () => {
    const s = sap();
    const args = { partner: '7000000010', companyCode: '1030', amount: 2500, currency: 'SAR', bankAccount: '220001' };
    expect(await preview(s, jordan, 'ar_requestIncomingPayment', args)).toMatchObject({
      action: 'Request incoming payment',
      proposedChange: 'Request an incoming payment of SAR 2,500 from Local Customer-01 to bank account 220001 in company code 1030.',
    });
    const created = await run(s, jordan, 'ar_requestIncomingPayment', args);
    expect(created.outputs).toMatchObject({ status: 'NEW' });
    const id = created.outputs!.paymentRequest!;

    const queue = await run(s, alex, 'gl_listPaymentRequests', { companyCode: '1030', status: 'NEW' });
    expect(queue.data.summary).toBe('1 payment request(s) with status "Waiting for approval" in company code 1030.');
    expect(queue.followUps).toEqual([{ label: 'Approve SAR 2,500', prompt: `Approve payment request ${id}.` }]);
    expect(queue.components![0]).toMatchObject({ type: 'business_object_table', data: { rows: [{ type: 'Incoming payment', status: 'Waiting for approval', id }] } });

    await run(s, alex, 'gl_approvePaymentRequest', { paymentRequest: id });
    expect((await preview(s, alex, 'gl_postPaymentRequest', { paymentRequest: id })).proposedChange).toBe('Post SAR 2,500: debit bank account 220001, credit customer Local Customer-01 (7000000010).');
    const posted = await run(s, alex, 'gl_postPaymentRequest', { paymentRequest: id });
    expect(posted.outputs).toMatchObject({ status: 'POSTED', accountingDocument: '5000007' });
    expect((await run(s, alex, 'gl_listPaymentRequests', {})).data.summary).toBe('1 payment request(s): 0 waiting for approval and 0 approved but not yet posted.');
  });
});

describe('sales order entry and credit', () => {
  const order = { soldTo: '7000000010', material: '5496', quantity: 10, salesOrganization: '1030', distributionChannel: '10', division: '00' };

  it('simulates price, availability and the credit check without saving', async () => {
    const s = sap();
    expect(await s.simulateSalesOrder(jordan, order)).toMatchObject({ netValue: { amount: 5000, currency: 'SAR' }, taxAmount: { amount: 600 }, creditStatus: 'APPROVED', items: [{ confirmedQuantity: 10 }] });
    // 100 PC: exposure 15,000 + 50,000 exceeds the limit of 50,000, and only 43 PC are in stock.
    expect(await s.simulateSalesOrder(jordan, { ...order, quantity: 100 })).toMatchObject({ creditStatus: 'BLOCKED', items: [{ confirmedQuantity: 43 }] });
    expect(await s.listOpenSalesOrders(jordan)).toHaveLength(2);

    const result = await run(s, jordan, 'sd_simulateSalesOrder', { customer: '7000000010', material: '5496', quantity: 100, salesOrganization: '1030', distributionChannel: '10', division: '00' });
    expect(result.data.summary).toMatch(/would be worth \*\*SAR 50,000\*\* net plus SAR 6,000 tax; the order would be \*\*blocked by the credit check\*\*\. Only 43 of 100 PC can be confirmed/);
  });

  it('creates an order that the order-to-cash steps can continue with', async () => {
    const s = sap();
    const created = await s.createSalesOrder(jordan, { ...order, customerReference: 'PO-77' });
    expect(created).toMatchObject({ number: '651', creditStatus: 'APPROVED', deliveryStatus: 'NOT_STARTED', netValue: { amount: 5000 }, customerReference: 'PO-77' });
    expect((await s.getCreditProfile(jordan, '7000000010')).exposure.amount).toBe(20000);
    expect((await s.createDelivery(jordan, '651')).salesOrder).toBe('651');
  });

  it('releases a credit block only with SAP authorization', async () => {
    const s = sap();
    await expect(s.releaseCreditBlock(jordan, '650')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(s.releaseCreditBlock(alex, '649')).rejects.toThrow(/not blocked by the credit check/);
    expect((await preview(s, alex, 'sd_releaseCreditBlock', { salesOrder: '650' })).impact).toMatch(/credit limit of SAR 100,000 and an exposure of SAR 236,000/);
    expect((await s.releaseCreditBlock(alex, '650')).creditStatus).toBe('APPROVED');
  });
});

describe('reversals', () => {
  const PO = '4200000403';

  it('reverses a supplier invoice and then the goods receipt, in that order', async () => {
    const s = sap();
    await s.postGoodsReceipt(alex, PO);
    const invoice = await s.createSupplierInvoice(alex, { purchaseOrder: PO, reference: 'VEN004', grossAmount: 3360 });
    await expect(s.reverseGoodsReceipt(alex, '7000000462', '2026')).rejects.toThrow(/Reverse the supplier invoice before the goods receipt/);

    const reversedInvoice = await run(s, alex, 'mm_reverseSupplierInvoice', { invoiceNumber: invoice.number, reason: '01' });
    expect(reversedInvoice.data.summary).toMatch(/was reversed with document/);
    expect((await s.getInvoice(alex, invoice.number)).status).toBe('REVERSED');
    expect(await s.getInvoicesForPurchaseOrder(alex, PO)).toEqual([]);
    expect(await openTotal(s, 'SUPPLIER', '7002200010')).toBe(-1120);
    await expect(s.reverseSupplierInvoice(alex, invoice.number, invoice.fiscalYear, '01')).rejects.toThrow(/already reversed/);

    expect((await preview(s, alex, 'mm_reverseGoodsReceipt', { purchaseOrder: PO })).proposedChange).toBe('Reverse material document 7000000462: 3 PC received from AL-QASSIM.');
    await run(s, alex, 'mm_reverseGoodsReceipt', { purchaseOrder: PO });
    expect((await s.getPurchaseOrder(alex, PO)).status).toBe('RELEASED');
    expect((await s.getMaterialStock(alex, '5496', '1030'))[0]!.unrestricted).toBe(43);
    const grir = (await s.listOpenItems(alex, { accountType: 'GL', account: '500030', companyCode: '1030', status: 'OPEN' })).filter((i) => i.assignment === PO);
    expect(grir.reduce((sum, i) => sum + i.amount.amount, 0)).toBe(0);

    // The order can go through purchase-to-pay again.
    expect(await s.postGoodsReceipt(alex, PO)).toHaveLength(1);
    await expect(run(s, alex, 'mm_reverseGoodsReceipt', { purchaseOrder: '4200000404' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to reverse a paid supplier invoice', async () => {
    await expect(sap().reverseSupplierInvoice(alex, '5105600002', '2026', '01')).rejects.toThrow(/already paid/);
  });

  it('cancels a billing document and then reverses the goods issue, in that order', async () => {
    const s = sap();
    const delivery = await s.createDelivery(alex, '649');
    await s.postGoodsIssue(alex, delivery.number);
    const billing = await s.createBillingDocument(alex, delivery.number);
    expect(await openTotal(s, 'CUSTOMER', '7000000010')).toBe(15000);
    await expect(run(s, alex, 'sd_reverseGoodsIssue', { salesOrder: '649' })).rejects.toThrow(/Cancel the billing document before reversing the goods issue/);

    const cancelled = await run(s, alex, 'sd_cancelBillingDocument', { billingDocument: billing.number });
    expect(cancelled.data.summary).toBe(`Billing document **${billing.number}** was cancelled with cancellation document **90000183**.`);
    expect((await s.getBillingDocument(alex, billing.number)).cancelled).toBe(true);
    expect(await openTotal(s, 'CUSTOMER', '7000000010')).toBe(2500);
    expect((await s.getSalesOrderFlow(alex, '649')).map((f) => f.category)).toEqual(['DELIVERY', 'GOODS_ISSUE']);
    await expect(s.cancelBillingDocument(alex, billing.number)).rejects.toThrow(/already cancelled/);

    const reversed = await run(s, alex, 'sd_reverseGoodsIssue', { salesOrder: '649' });
    expect(reversed.components![0]).toMatchObject({ type: 'outbound_delivery', data: { goodsIssueStatus: 'NOT_STARTED' } });
    expect((await s.getMaterialStock(alex, '5496', '1030'))[0]!.unrestricted).toBe(43);
    expect((await s.getSalesOrderFlow(alex, '649')).map((f) => f.category)).toEqual(['DELIVERY']);
  });

  it('refuses to cancel a paid invoice and requests a credit memo instead', async () => {
    const s = sap();
    await expect(s.cancelBillingDocument(alex, '90000181')).rejects.toThrow(/already paid \(clearing document 5000006\)/);
    const request = await run(s, alex, 'sd_createCreditMemoRequest', { billingDocument: '90000181', reason: '001' });
    expect(request.data.summary).toBe('Credit memo request **60000001** for **Local Customer-01** over **SAR 5,000** was created for billing document **90000181**.');
  });
});
