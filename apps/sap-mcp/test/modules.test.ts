import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_META, UIComponentSchema } from '@prowess/contracts';
import { createLogger } from '@prowess/observability';
import { HEADERS, MCP_AUDIENCE, signAssertion, type PrincipalAssertion } from '@prowess/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from '../src/app.js';
import { loadConfig, type McpConfig } from '../src/config.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import { BUSINESS_DOMAINS } from '../src/tools/types.js';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const cfg: McpConfig = {
  port: 0,
  environment: 'DEV',
  assertionSecret: SECRET,
  domains: new Set(BUSINESS_DOMAINS),
  sap: { mode: 'mock', destinationName: 'S4', systemId: 'S4-MOCK', allowTechnicalUser: false, mockLatencyMs: 0 },
  toolTimeoutMs: 5_000,
  logLevel: 'error',
};

let client: Client;
const server = createMcpHttpServer(cfg, { gateway: new MockSapGateway(0), logger: createLogger({ service: 't', level: 'error', sink: () => {} }) });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  const principal = signAssertion<PrincipalAssertion>(
    { typ: 'principal', sub: 'jordan.lee@prowess.example', name: 'Jordan', tenant: 't1', roles: ['AI_USER'], env: 'DEV', agent: 'sd', cid: 'PRW-TEST', aud: MCP_AUDIENCE },
    SECRET,
    60,
  );
  client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { [HEADERS.principal]: principal } } }),
  );
});
afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

interface Structured {
  data: Record<string, unknown> & { summary: string; findings?: string[]; nextSteps?: string[] };
  components: { type: string; data: Record<string, unknown> }[];
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const sc = res.structuredContent as Structured;
  if (!res.isError) for (const c of sc.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return { isError: res.isError === true, sc, raw: JSON.stringify(res.structuredContent) };
}

describe('tool domains follow SAP modules', () => {
  it('names every tool after its module and keeps the new tools read-only', async () => {
    const { tools } = await client.listTools();
    const byDomain = new Map<string, string[]>();
    for (const t of tools) {
      const domain = String(t._meta?.[MCP_META.domain]);
      expect(t.name.startsWith(`${domain}_`), t.name).toBe(true);
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), t.name]);
    }
    expect([...byDomain.keys()].sort()).toEqual([...BUSINESS_DOMAINS, 'system'].sort());
    const writes = tools.filter((t) => t._meta?.[MCP_META.risk] !== 'READ').map((t) => t.name);
    expect(writes.sort()).toEqual([
      'ap_requestOutgoingPayment',
      'ar_requestIncomingPayment',
      'gl_approvePaymentRequest',
      'gl_clearOpenItems',
      'gl_postJournalEntry',
      'gl_postPaymentRequest',
      'gl_rejectPaymentRequest',
      'mm_addInvoiceNote',
      'mm_createPurchaseOrder',
      'mm_createPurchaseRequisition',
      'mm_createSupplierInvoice',
      'mm_postGoodsReceipt',
      'mm_releaseInvoicePaymentBlock',
      'mm_reverseGoodsReceipt',
      'mm_reverseSupplierInvoice',
      'sd_cancelBillingDocument',
      'sd_createBillingDocument',
      'sd_createCreditMemoRequest',
      'sd_createDelivery',
      'sd_createSalesOrder',
      'sd_postGoodsIssue',
      'sd_releaseCreditBlock',
      'sd_reverseGoodsIssue',
      'sd_setItemPrice',
      'sd_setItemWeight',
      'sd_updateSalesOrder',
    ]);
  });

  it('expands the former fico domain so existing deployments keep their tools', () => {
    const domains = loadConfig({ SERVICE_ASSERTION_SECRET: SECRET, MCP_DOMAINS: 'fico,mm,pm,shared' }).domains;
    expect([...domains].sort()).toEqual(['ap', 'ar', 'credit', 'gl', 'mm', 'pm', 'shared']);
  });
});

describe('order-to-cash in company code 1030', () => {
  it('traces sales order 648 through delivery, goods issue, billing and accounting', async () => {
    const { sc } = await call('sd_getSalesOrderFlow', { salesOrder: '648' });
    expect(sc.components.map((c) => c.type)).toEqual(['sales_order', 'timeline']);
    expect(sc.components[0]!.data).toMatchObject({ number: '648', soldTo: '7000000010', deliveryStatus: 'COMPLETE', billingStatus: 'COMPLETE', netValue: { amount: 5000, currency: 'SAR' } });
    const flow = (sc.data.flow as string[]).join('\n');
    for (const document of ['80000257', '1000000000', '90000181', '1000000001']) expect(flow).toContain(document);
    expect(sc.data.nextSteps).toEqual([]);
  });

  it('says what is outstanding for an order that has not been delivered', async () => {
    const { sc } = await call('sd_getSalesOrderFlow', { salesOrder: '649' });
    expect(sc.data.nextSteps).toEqual(['Create the outbound delivery (VL01N).']);
  });

  it('links the billing document to its accounting document', async () => {
    const billing = await call('sd_getBillingDocument', { billingDocument: '90000181' });
    expect(billing.sc.components[0]!.data).toMatchObject({ postedToAccounting: true, accountingDocument: '1000000001', companyCode: '1030' });
    const journal = await call('gl_getAccountingDocument', { documentNumber: '1000000001', companyCode: '1030', fiscalYear: '2026' });
    expect(journal.sc.data.summary).toMatch(/balances to zero/);
    expect(journal.sc.components[0]!.data.items).toEqual([
      expect.objectContaining({ account: '7000000010', debitCredit: 'D', amount: { amount: 5000, currency: 'SAR' } }),
      expect.objectContaining({ account: '700000', debitCredit: 'C', amount: { amount: -5000, currency: 'SAR' } }),
    ]);
  });

  it('shows that payment 5000006 cleared the billing document and what is still open', async () => {
    const { sc } = await call('ar_listCustomerOpenItems', { customer: '7000000010', companyCode: '1030', status: 'ALL' });
    const items = sc.components[0]!.data.items as { document: string; status: string; clearingDocument?: string }[];
    expect(items.find((i) => i.document === '1000000001')).toMatchObject({ status: 'CLEARED', clearingDocument: '5000006' });
    expect(items.find((i) => i.document === '2000016')).toMatchObject({ status: 'OVERDUE' });
    expect(sc.data.openBalance).toBe('SAR 2,500');

    const openOnly = await call('ar_listCustomerOpenItems', { customer: '7000000010', companyCode: '1030' });
    expect((openOnly.sc.components[0]!.data.items as unknown[]).length).toBe(1);
  });

  it('flags a customer whose exposure is above the credit limit', async () => {
    const { sc } = await call('credit_getCreditExposure', { customer: '7000000011' });
    expect(sc.data.summary).toMatch(/above the limit/);
    expect(sc.data.findings![0]).toMatch(/exceeds the credit limit by SAR 136,000/);
  });
});

describe('order-to-cash postings', () => {
  const ctx = { principal: { sub: 'jordan.lee@prowess.example' }, correlationId: 't' } as never;

  it('refuses every write that has not been confirmed', async () => {
    for (const name of ['sd_createDelivery', 'sd_postGoodsIssue', 'sd_createBillingDocument']) {
      const res = await call(name, { salesOrder: '649' });
      expect(res.isError).toBe(true);
      expect(res.raw).toContain('CONFIRMATION_REQUIRED');
    }
  });

  it('previews the delivery without changing SAP', async () => {
    const { sc } = await call('system_previewAction', { tool: 'sd_createDelivery', arguments: { salesOrder: '649' } });
    expect(sc.data.preview).toMatchObject({ action: 'Create outbound delivery', businessObject: { type: 'Sales order', id: '649' } });
    expect((await call('sd_getSalesOrder', { salesOrder: '649' })).sc.components[0]!.data.deliveryStatus).toBe('NOT_STARTED');
  });

  it('delivers, issues and bills an order, leaving a receivable and a balanced flow', async () => {
    const sap = new MockSapGateway(0);
    const delivery = await sap.createDelivery(ctx, '649');
    await expect(sap.createBillingDocument(ctx, delivery.number)).rejects.toThrow(/Goods issue has not been posted/);
    const issued = await sap.postGoodsIssue(ctx, delivery.number);
    expect(issued.goodsIssueStatus).toBe('COMPLETE');
    expect((await sap.getMaterialStock(ctx, '5496', '1030'))[0]!.unrestricted).toBe(18);
    const billing = await sap.createBillingDocument(ctx, delivery.number);
    expect(billing).toMatchObject({ netValue: { amount: 12500, currency: 'SAR' }, postedToAccounting: true, salesOrder: '649' });

    expect((await sap.getSalesOrderFlow(ctx, '649')).map((s) => s.category)).toEqual(['DELIVERY', 'GOODS_ISSUE', 'BILLING', 'ACCOUNTING']);
    const open = await sap.listOpenItems(ctx, { accountType: 'CUSTOMER', account: '7000000010', companyCode: '1030', status: 'OPEN' });
    expect(open.map((i) => i.amount.amount).sort((a, b) => a - b)).toEqual([2500, 12500]);
    await expect(sap.createDelivery(ctx, '649')).rejects.toThrow(/already completely delivered/);
    await expect(sap.postGoodsIssue(ctx, delivery.number)).rejects.toThrow(/already been posted/);
  });

  it('will not deliver a credit-blocked order', async () => {
    await expect(new MockSapGateway(0).createDelivery(ctx, '650')).rejects.toThrow(/blocked by the credit check/);
  });
});

describe('purchase-to-pay in company code 1030', () => {
  it('reads the purchase order, its goods receipt and the paid invoice', async () => {
    const po = await call('mm_getPurchaseOrder', { purchaseOrderNumber: '4200000402' });
    expect(po.sc.components[0]!.data).toMatchObject({ vendorId: '7002200010', value: { amount: 2000, currency: 'SAR' } });
    const gr = await call('mm_getGoodsReceipt', { purchaseOrder: '4200000402' });
    expect(gr.sc.data.summary).toMatch(/totalling \*\*2 PC\*\*/);
    const paid = await call('ap_getPaymentStatus', { invoiceNumber: '5105600002' });
    expect(paid.sc.data.summary).toMatch(/paid on \*\*2026-09-28\*\* \(payment document 3000007\)/);
  });

  it('lists the supplier line items and the payable that is due', async () => {
    const all = await call('ap_listVendorOpenItems', { supplier: '7002200010', companyCode: '1030', status: 'ALL' });
    const items = all.sc.components[0]!.data.items as { document: string; status: string; clearingDocument?: string }[];
    expect(items.find((i) => i.document === '2001001')).toMatchObject({ status: 'CLEARED', clearingDocument: '3000007' });
    const due = await call('ap_listInvoicesDue', { companyCode: '1030' });
    expect(due.sc.data.summary).toMatch(/1 supplier item\(s\) totalling \*\*SAR 1,120\*\*/);
  });

  it('reconciles the GR/IR clearing account per purchase order', async () => {
    const { sc } = await call('gl_listGRIROpenItems', { companyCode: '1030', glAccount: '500030' });
    expect(sc.data.findings).toEqual([]);
    expect(sc.data.nextSteps![0]).toMatch(/F\.13/);
    expect(sc.components[0]!.data).toMatchObject({ accountType: 'GL', total: { amount: 0, currency: 'SAR' } });
  });

  it('shows stock and the source of supply for a material', async () => {
    const stock = await call('mm_getMaterialStock', { material: '5496', plant: '1030' });
    expect(stock.sc.data.summary).toMatch(/\*\*43 PC\*\* in unrestricted-use stock in plant 1030/);
    const sources = await call('mm_getInfoRecords', { material: '5496' });
    expect(sources.sc.data.summary).toMatch(/AL-QASSIM.*last purchase order 4200000402/);
  });
});

describe('monitoring lists', () => {
  it('finds open orders, overdue receivables and blocked invoices', async () => {
    const orders = await call('sd_listOpenSalesOrders', {});
    expect(orders.sc.data.summary).toBe('2 sales order(s) are open, 1 of them blocked by the credit check.');
    const overdue = await call('ar_listOverdueReceivables', { companyCode: '1030' });
    expect(overdue.sc.data.summary).toMatch(/2 customer item\(s\) totalling \*\*SAR 98,500\*\* are overdue/);
    const blocked = await call('mm_listBlockedInvoices', { companyCode: '1000' });
    expect(blocked.sc.data.summary).toMatch(/1 supplier invoice\(s\) totalling \*\*SAR 428,350\*\*/);
    const none = await call('mm_listBlockedInvoices', { companyCode: '1030' });
    expect(none.sc.components).toEqual([]);
  });

  it('keeps SAP company-code authorization on line items', async () => {
    const res = await call('ar_listCustomerOpenItems', { customer: '7000000010', companyCode: '3000' });
    expect(res.isError).toBe(true);
    expect(res.raw).toContain('SAP_NOT_AUTHORIZED');
  });
});
