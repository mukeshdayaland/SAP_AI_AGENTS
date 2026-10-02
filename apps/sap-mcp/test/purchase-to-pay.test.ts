import { describe, expect, it } from 'vitest';
import { MockSapGateway } from '../src/sap/mock-gateway.js';

const ctx = { principal: { sub: 'jordan.lee@prowess.example' }, correlationId: 't' } as never;
const PO = '4200000403'; // released, 3 PC at SAR 1,000, nothing received yet
const sap = () => new MockSapGateway(0);

describe('purchase-to-pay postings', () => {
  it('receives the goods, then posts a matching invoice that is open for payment', async () => {
    const s = sap();
    const receipts = await s.postGoodsReceipt(ctx, PO);
    expect(receipts).toEqual([expect.objectContaining({ purchaseOrder: PO, quantity: 3, unit: 'PC', value: { amount: 3000, currency: 'SAR' } })]);
    expect((await s.getPurchaseOrder(ctx, PO)).status).toBe('DELIVERED');
    expect((await s.getMaterialStock(ctx, '5496', '1030'))[0]!.unrestricted).toBe(46);
    await expect(s.postGoodsReceipt(ctx, PO)).rejects.toThrow(/already completely received/);

    const invoice = await s.createSupplierInvoice(ctx, { purchaseOrder: PO, reference: 'VEN004', grossAmount: 3360 });
    expect(invoice).toMatchObject({ status: 'OPEN', paymentBlock: null, gross: { amount: 3360, currency: 'SAR' }, purchaseOrder: PO, reference: 'VEN004' });
    expect(await s.getInvoicesForPurchaseOrder(ctx, PO)).toHaveLength(1);

    // The payable is on the supplier account and GR/IR balances for this order.
    const payables = await s.listOpenItems(ctx, { accountType: 'SUPPLIER', account: '7002200010', companyCode: '1030', status: 'OPEN' });
    expect(payables.map((i) => i.amount.amount).sort((a, b) => a - b)).toEqual([-3360, -1120]);
    const grir = (await s.listOpenItems(ctx, { accountType: 'GL', account: '500030', companyCode: '1030', status: 'OPEN' })).filter((i) => i.assignment === PO);
    expect(grir.reduce((sum, i) => sum + i.amount.amount, 0)).toBe(0);
  });

  it('refuses a second invoice for the order and a repeated supplier reference', async () => {
    const s = sap();
    await s.postGoodsReceipt(ctx, PO);
    await s.createSupplierInvoice(ctx, { purchaseOrder: PO, reference: 'VEN004', grossAmount: 3360 });
    await expect(s.createSupplierInvoice(ctx, { purchaseOrder: PO, reference: 'VEN005', grossAmount: 3360 })).rejects.toThrow(/already been invoiced/);

    const other = await s.createPurchaseOrder(ctx, { supplier: '7002200010', material: '5496', plant: '1030', quantity: 1, companyCode: '1030', purchasingOrganization: '1030', purchasingGroup: '103' });
    await s.postGoodsReceipt(ctx, other.number);
    await expect(s.createSupplierInvoice(ctx, { purchaseOrder: other.number, reference: 'VEN004', grossAmount: 1120 })).rejects.toThrow(/duplicate invoice check/);
  });

  it('posts an invoice with a price variance blocked for payment', async () => {
    const s = sap();
    await s.postGoodsReceipt(ctx, PO);
    const invoice = await s.createSupplierInvoice(ctx, { purchaseOrder: PO, reference: 'VEN004', grossAmount: 3900 });
    expect(invoice).toMatchObject({ status: 'PAYMENT_BLOCKED', paymentBlock: { code: 'R' } });
    expect(invoice.varianceChecks![0]).toMatchObject({ type: 'PRICE', withinTolerance: false });
    expect(invoice.varianceChecks![0]!.message).toMatch(/Invoiced SAR 3,900 gross, but the goods received are worth SAR 3,360 gross/);
    expect((await s.listBlockedInvoices(ctx, '1030')).map((i) => i.number)).toEqual([invoice.number]);
  });

  it('blocks an invoice that arrives before the goods', async () => {
    const invoice = await sap().createSupplierInvoice(ctx, { purchaseOrder: PO, reference: 'VEN004', grossAmount: 3360 });
    expect(invoice.status).toBe('PAYMENT_BLOCKED');
    expect(invoice.varianceChecks![0]).toMatchObject({ type: 'QUANTITY' });
  });

  it('creates a purchase order at the info record price and a requisition', async () => {
    const s = sap();
    const order = { supplier: '7002200010', material: '5496', plant: '1030', quantity: 4, companyCode: '1030', purchasingOrganization: '1030', purchasingGroup: '103' };
    const po = await s.createPurchaseOrder(ctx, order);
    expect(po).toMatchObject({ number: '4200000404', vendorName: 'AL-QASSIM', value: { amount: 4000, currency: 'SAR' }, status: 'RELEASED' });
    expect((await s.createPurchaseOrder(ctx, { ...order, netPrice: 900 })).value.amount).toBe(3600);

    await expect(s.createPurchaseOrder(ctx, { ...order, supplier: '9999999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.createPurchaseOrder(ctx, { ...order, companyCode: '3000' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });

    const pr = await s.createPurchaseRequisition(ctx, { material: '5496', plant: '1030', quantity: 5 });
    expect(pr).toMatchObject({ status: 'OPEN', value: { amount: 5000, currency: 'SAR' } });
    expect((await s.getPurchaseRequisition(ctx, pr.number)).number).toBe(pr.number);
  });
});
