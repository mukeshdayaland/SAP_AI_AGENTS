import { createLogger } from '@prowess/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SentRequest {
  method: string;
  url: string;
  params?: Record<string, string>;
  data?: unknown;
  headers: Record<string, string>;
}

// The SAP Cloud SDK is replaced by a recorder: these tests check what the gateway sends and how it reads replies.
const sdk = vi.hoisted(() => ({
  sent: [] as { request: SentRequest; options: { fetchCsrfToken: boolean } }[],
  reply: (_request: SentRequest): unknown => ({}),
}));

vi.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: async (_destination: unknown, request: SentRequest, options: { fetchCsrfToken: boolean }) => {
    sdk.sent.push({ request, options });
    return { data: sdk.reply(request) };
  },
}));

const { ODataSapGateway } = await import('../src/sap/odata-gateway.js');

const gateway = new ODataSapGateway({ destinationName: 'S4HANA', systemId: 'S4-DEV', allowTechnicalUser: false, logger: createLogger({ service: 't', level: 'error', sink: () => {} }) });
const ctx = { principal: { sub: 'user@example.com' }, userJwt: 'jwt', correlationId: 'PRW-1' } as never;

const rejected = (status: number, data: unknown) => Object.assign(new Error('request failed'), { response: { status, data } });
const billingReply = { d: { BillingDocument: '90000182', BillingDocumentType: 'F2', PayerParty: '7000000010', TotalNetAmount: '12500.00', TransactionCurrency: 'SAR', CompanyCode: '1030', AccountingPostingStatus: 'C', to_Item: { results: [] } } };

beforeEach(() => {
  sdk.sent.length = 0;
  sdk.reply = () => ({});
});

describe('OData V4: billing document', () => {
  it('calls the static CreateFromSDDocument action and reads the created document back', async () => {
    sdk.reply = (r) => {
      if (r.url.includes('/odata4/')) return { value: [{ BillingDocument: '90000182' }] };
      if (r.url.includes('A_Customer')) return { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };
      return billingReply;
    };
    const doc = await gateway.createBillingDocument(ctx, '80000258');

    const action = sdk.sent[0]!;
    expect(action.request.method).toBe('post');
    expect(action.request.url).toBe('/sap/opu/odata4/sap/api_billingdocument/srvd/sap/api_billingdocument/0001/BillingDocument/SAP__self.CreateFromSDDocument');
    expect(action.request.data).toEqual({ _Reference: [{ SDDocument: '80000258' }], _Control: { AutomPostingToAcctgIsDisabled: false } });
    // V4 takes no $format, and a write needs a CSRF token.
    expect(action.request.params).toBeUndefined();
    expect(action.options.fetchCsrfToken).toBe(true);
    expect(action.request.headers).toMatchObject({ 'content-type': 'application/json', 'x-correlation-id': 'PRW-1' });

    expect(doc).toMatchObject({ number: '90000182', payerName: 'Local Customer-01', netValue: { amount: 12500, currency: 'SAR' }, postedToAccounting: true });
  });

  it('passes on SAP’s reason when the posting is rejected', async () => {
    sdk.reply = () => {
      throw rejected(400, { error: { code: 'VF/041', message: 'Delivery 80000258 has not\n been goods issued' } });
    };
    await expect(gateway.createBillingDocument(ctx, '80000258')).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      message: 'SAP rejected Billing document for delivery 80000258: Delivery 80000258 has not been goods issued',
    });
  });

  it('reports a business error when SAP answers without a document', async () => {
    sdk.reply = () => ({ value: [] });
    await expect(gateway.createBillingDocument(ctx, '80000258')).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
  });
});

describe('OData V4: payment request service', () => {
  const ID = '0a1b2c3d-1111-4222-8333-444455556666';
  const BASE = '/sap/opu/odata4/sap/zapi_fi_agentpayment_o4/srvd/sap/zapi_fi_agentpayment/0001';
  const entity = (status: string, extra: Record<string, unknown> = {}) => ({ PaymentUUID: ID, PaymentDirection: 'I', CompanyCode: '1030', Customer: '7000000010', Supplier: '', BankGLAccount: '220001', Amount: 2500, Currency: 'SAR', Status: status, FiscalYear: '0000', CreatedBy: 'JORDAN', CreatedAt: '2026-10-02T10:00:00Z', ...extra });
  const customer = { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };

  it('creates a request for an incoming payment', async () => {
    sdk.reply = (r) => (r.url.includes('/odata4/') ? entity('N') : customer);
    const request = await gateway.createPaymentRequest(ctx, { direction: 'INCOMING', companyCode: '1030', partner: '7000000010', amount: 2500, currency: 'SAR', bankAccount: '220001', reference: 'BANK-0001', text: 'A header text that is longer than SAP allows' });

    expect(sdk.sent[0]!.request).toMatchObject({ method: 'post', url: `${BASE}/Payment` });
    expect(sdk.sent[0]!.request.data).toEqual({ PaymentDirection: 'I', CompanyCode: '1030', Customer: '7000000010', BankGLAccount: '220001', Amount: 2500, Currency: 'SAR', DocumentReferenceID: 'BANK-0001', HeaderText: 'A header text that is lon' });
    expect(request).toMatchObject({ id: ID, direction: 'INCOMING', status: 'NEW', partnerName: 'Local Customer-01', amount: { amount: 2500, currency: 'SAR' }, createdBy: 'JORDAN', createdOn: '2026-10-02' });
    expect(request.fiscalYear).toBeUndefined();
  });

  it('calls the bound actions with an ETag and reads the request again for the document number', async () => {
    sdk.reply = (r) => (r.method === 'post' ? {} : r.url.includes('/odata4/') ? entity('P', { AccountingDocument: '1400000012', FiscalYear: '2026', ApprovedBy: 'ALEX' }) : customer);
    const posted = await gateway.postPaymentRequest(ctx, ID.toUpperCase());

    expect(sdk.sent[0]!.request).toMatchObject({ method: 'post', url: `${BASE}/Payment(${ID})/SAP__self.post`, data: {} });
    expect(sdk.sent[0]!.request.headers).toMatchObject({ 'if-match': '*', 'content-type': 'application/json' });
    expect(sdk.sent[1]!.request).toMatchObject({ method: 'get', url: `${BASE}/Payment(${ID})` });
    expect(posted).toMatchObject({ status: 'POSTED', accountingDocument: '1400000012', fiscalYear: '2026', approvedBy: 'ALEX' });

    sdk.sent.length = 0;
    await gateway.approvePaymentRequest(ctx, ID);
    await gateway.rejectPaymentRequest(ctx, ID);
    expect(sdk.sent.filter((s) => s.request.method === 'post').map((s) => s.request.url.split('/').at(-1))).toEqual(['SAP__self.approve', 'SAP__self.reject']);
  });

  it('filters the approval queue and refuses anything but a UUID as key', async () => {
    sdk.reply = (r) => (r.url.includes('/odata4/') ? { value: [entity('N')] } : customer);
    expect(await gateway.listPaymentRequests(ctx, { companyCode: '1030', status: 'NEW' })).toHaveLength(1);
    expect(sdk.sent[0]!.request.params).toEqual({ $filter: "CompanyCode eq '1030' and Status eq 'N'", $orderby: 'CreatedAt desc', $top: '50' });

    sdk.sent.length = 0;
    await expect(gateway.getPaymentRequest(ctx, "1)/Payment('x")).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(sdk.sent).toHaveLength(0);
  });

  it("passes on SAP's reason when the creator tries to approve", async () => {
    sdk.reply = () => {
      throw rejected(400, { error: { code: 'ZFI/001', message: 'The creator of a payment request cannot approve it' } });
    };
    await expect(gateway.approvePaymentRequest(ctx, ID)).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: `SAP rejected Approval of payment request ${ID}: The creator of a payment request cannot approve it` });
  });
});

describe('OData V2: sales order entry, reversals and G/L totals', () => {
  const posted = () => sdk.sent.find((s) => s.request.method === 'post')!;
  const order = { soldTo: '7000000010', material: '5496', quantity: 10, salesOrganization: '1030', distributionChannel: '10', division: '00' };

  it('creates a sales order', async () => {
    sdk.reply = (r) => {
      if (r.method === 'post') return { d: { SalesOrder: '651' } };
      if (r.url.includes('A_SalesOrder')) return { d: { SalesOrder: '651', SoldToParty: '7000000010', to_Item: { results: [] } } };
      return { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };
    };
    const created = await gateway.createSalesOrder(ctx, { ...order, customerReference: 'PO-77', requestedDeliveryDate: '2026-10-15' });

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder');
    expect(posted().request.data).toEqual({
      SalesOrderType: 'OR',
      SalesOrganization: '1030',
      DistributionChannel: '10',
      OrganizationDivision: '00',
      SoldToParty: '7000000010',
      PurchaseOrderByCustomer: 'PO-77',
      RequestedDeliveryDate: `/Date(${Date.UTC(2026, 9, 15)})/`,
      to_Item: { results: [{ Material: '5496', RequestedQuantity: '10' }] },
    });
    expect(created.number).toBe('651');
  });

  it('simulates a sales order and reads price, confirmation and credit status', async () => {
    sdk.reply = (r) =>
      r.method === 'post'
        ? { d: { to_Pricing: { TotalNetAmount: '5000.00', TransactionCurrency: 'SAR' }, to_Credit: { TotalCreditCheckStatus: 'B' }, to_Item: { results: [{ Material: '5496', RequestedQuantity: '10', RequestedQuantityUnit: 'PC', NetAmount: '5000.00', ConfdDelivQtyInOrderQtyUnit: '4' }] } } }
        : { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };
    const sim = await gateway.simulateSalesOrder(ctx, order);

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_SALES_ORDER_SIMULATION_SRV/A_SalesOrderSimulation');
    expect(sim).toMatchObject({ soldToName: 'Local Customer-01', netValue: { amount: 5000, currency: 'SAR' }, creditStatus: 'BLOCKED', items: [{ quantity: 10, unit: 'PC', confirmedQuantity: 4 }] });
  });

  it('reverses a goods receipt, a supplier invoice and a goods issue through the function imports', async () => {
    const day = expect.stringMatching(/^datetime'\d{4}-\d{2}-\d{2}T00:00:00'$/);

    sdk.reply = () => ({ d: { MaterialDocument: '5000000013', MaterialDocumentYear: '2026' } });
    expect(await gateway.reverseGoodsReceipt(ctx, '5000000012', '2026')).toEqual({ document: '5000000013', year: '2026', reversedDocument: '5000000012' });
    expect(sdk.sent[0]!.request).toMatchObject({ method: 'post', url: '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/Cancel' });
    expect(sdk.sent[0]!.request.params).toEqual({ MaterialDocumentYear: "'2026'", MaterialDocument: "'5000000012'", PostingDate: day });

    sdk.sent.length = 0;
    sdk.reply = () => ({ d: { Cancel: { ReverseDocument: '5105600009', FiscalYear: '2026' } } });
    expect(await gateway.reverseSupplierInvoice(ctx, '5105600003', '2026', '01')).toEqual({ document: '5105600009', year: '2026', reversedDocument: '5105600003' });
    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/Cancel');
    expect(sdk.sent[0]!.request.params).toEqual({ FiscalYear: "'2026'", SupplierInvoice: "'5105600003'", ReversalReason: "'01'", PostingDate: day });

    sdk.sent.length = 0;
    sdk.reply = (r) => (r.url.includes('A_OutbDeliveryHeader') ? { d: { DeliveryDocument: '80000258', OverallGoodsMovementStatus: 'A', to_DeliveryDocumentItem: { results: [] } } } : {});
    expect((await gateway.reverseGoodsIssue(ctx, '80000258')).goodsIssueStatus).toBe('NOT_STARTED');
    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/ReverseGoodsIssue');
    expect(sdk.sent[0]!.request.headers).toMatchObject({ 'if-match': '*' });
  });

  it('changes the existing price condition of an order item, or adds one when there is none', async () => {
    const order = { d: { SalesOrder: '658', SoldToParty: '7000000010', to_Item: { results: [] } } };
    sdk.reply = (r) => {
      if (r.url.endsWith('/to_PricingElement') && r.method === 'get') return { d: { results: [{ ConditionType: 'PPR0', PricingProcedureStep: '10', PricingProcedureCounter: '1' }] } };
      if (r.url.includes('A_SalesOrder(')) return order;
      return { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };
    };
    await gateway.setSalesOrderItemPrice(ctx, '658', '10', 100, 'SAR');
    const patch = sdk.sent.find((s) => (s.request.method as string) === 'patch')!.request;
    expect(patch.url).toBe("/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderItemPrElement(SalesOrder='658',SalesOrderItem='10',PricingProcedureStep='10',PricingProcedureCounter='1')");
    expect(patch.data).toEqual({ ConditionRateValue: '100', ConditionCurrency: 'SAR' });
    expect(patch.headers).toMatchObject({ 'if-match': '*', 'x-requested-with': 'XMLHttpRequest' });
    expect(patch.params).toBeUndefined();

    sdk.sent.length = 0;
    sdk.reply = (r) => (r.url.endsWith('/to_PricingElement') && r.method === 'get' ? { d: { results: [] } } : r.url.includes('A_SalesOrder(') ? order : { d: {} });
    await gateway.setSalesOrderItemPrice(ctx, '658', '10', 100, 'SAR', 'PPR0');
    const post = sdk.sent.find((s) => s.request.method === 'post')!.request;
    expect(post.url).toBe("/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderItem(SalesOrder='658',SalesOrderItem='10')/to_PricingElement");
    expect(post.data).toEqual({ ConditionType: 'PPR0', ConditionRateValue: '100', ConditionCurrency: 'SAR' });
  });

  it('changes order header data and the shipping point of every item', async () => {
    const order = { d: { SalesOrder: '658', SoldToParty: '7000000010', to_Item: { results: [{ SalesOrderItem: '10' }, { SalesOrderItem: '20' }] } } };
    sdk.reply = (r) => (r.url.includes('A_SalesOrder(') && r.method === 'get' ? order : { d: {} });
    await gateway.updateSalesOrder(ctx, '658', { customerReference: 'PO-4711', incoterms: 'EXW', incotermsLocation: 'Riyadh', shippingPoint: '1030' });
    const patches = sdk.sent.filter((s) => (s.request.method as string) === 'patch').map((s) => s.request);
    expect(patches.map((p) => p.url)).toEqual([
      "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder('658')",
      "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderItem(SalesOrder='658',SalesOrderItem='10')",
      "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderItem(SalesOrder='658',SalesOrderItem='20')",
    ]);
    expect(patches[0]!.data).toEqual({ PurchaseOrderByCustomer: 'PO-4711', IncotermsClassification: 'EXW', IncotermsLocation1: 'Riyadh', IncotermsTransferLocation: 'Riyadh' });
    expect(patches[1]!.data).toEqual({ ShippingPoint: '1030' });
    expect(patches[0]!.headers).toMatchObject({ 'if-match': '*', 'x-requested-with': 'XMLHttpRequest' });
  });

  it('sets item weights through the custom action', async () => {
    sdk.reply = (r) => (r.url.includes('A_SalesOrder(') ? { d: { SalesOrder: '658', SoldToParty: '7000000010', to_Item: { results: [] } } } : {});
    await gateway.setSalesOrderItemWeight(ctx, '658', '10', 30, 25, 'KG');
    const post = sdk.sent.find((s) => s.request.method === 'post')!.request;
    expect(post.url).toBe("/sap/opu/odata4/sap/zapi_sd_incompletionlog_o4/srvd/sap/zapi_sd_incompletionlog/0001/ItemWeight(SalesOrder='0000000658',SalesOrderItem='000010')/SAP__self.setWeight");
    expect(post.data).toEqual({ GrossWeight: 30, NetWeight: 25, WeightUnit: 'KG' });
  });

  it('reads the incompletion log from the custom service', async () => {
    sdk.reply = () => ({
      value: [
        { SalesDocument: '0000000658', SalesDocumentItem: '000010', TableName: 'VBAP', FieldName: 'LGORT', FieldLabel: 'Storage Location', PartnerFunction: '', BlocksDelivery: true, BlocksBilling: false },
        { SalesDocument: '0000000658', SalesDocumentItem: '000000', TableName: 'VBKD', FieldName: 'BSTKD', FieldLabel: '', PartnerFunction: '', BlocksDelivery: false, BlocksBilling: true },
      ],
    });
    expect(await gateway.getIncompletionLog(ctx, '658')).toEqual([
      { item: '10', field: 'Storage Location', table: 'VBAP', fieldName: 'LGORT', blocksDelivery: true, blocksBilling: false },
      { field: 'VBKD-BSTKD', table: 'VBKD', fieldName: 'BSTKD', blocksDelivery: false, blocksBilling: true },
    ]);
    const req = sdk.sent.at(-1)!.request;
    expect(req.url).toBe('/sap/opu/odata4/sap/zapi_sd_incompletionlog_o4/srvd/sap/zapi_sd_incompletionlog/0001/IncompletionLog');
    expect(req.params).toMatchObject({ $filter: "SalesDocument eq '0000000658'" });
  });

  it('falls back to PR00 when the pricing procedure has no PPR0, as in RVAA01', async () => {
    const order = { d: { SalesOrder: '658', SoldToParty: '7000000010', to_Item: { results: [] } } };
    sdk.reply = (r) => {
      if (r.url.endsWith('/to_PricingElement') && r.method === 'get') return { d: { results: [] } };
      if (r.method === 'post' && (r.data as { ConditionType: string }).ConditionType === 'PPR0') {
        throw rejected(400, { error: { message: { value: 'Condition PPR0 is missing in pricing procedure A V RVAA01' } } });
      }
      return r.url.includes('A_SalesOrder(') ? order : { d: {} };
    };
    await gateway.setSalesOrderItemPrice(ctx, '658', '10', 100, 'SAR');
    expect(sdk.sent.filter((s) => s.request.method === 'post').map((s) => (s.request.data as { ConditionType: string }).ConditionType)).toEqual(['PPR0', 'PR00']);

    // Any other rejection is reported, not retried.
    sdk.sent.length = 0;
    sdk.reply = (r) => {
      if (r.url.endsWith('/to_PricingElement') && r.method === 'get') return { d: { results: [] } };
      if (r.method === 'post') throw rejected(400, { error: { message: { value: 'Item 10 is already billed' } } });
      return order;
    };
    await expect(gateway.setSalesOrderItemPrice(ctx, '658', '10', 100, 'SAR')).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: expect.stringMatching(/already billed/) });
    expect(sdk.sent.filter((s) => s.request.method === 'post')).toHaveLength(1);
  });

  it('says clearly what the released APIs cannot do', async () => {
    await expect(gateway.cancelBillingDocument()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(gateway.releaseCreditBlock()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(sdk.sent).toHaveLength(0);
  });

});

describe('OData V2: finance analysis services', () => {
  const posts = () => sdk.sent.filter((s) => s.request.method === 'post').map((s) => s.request);

  it('reads the G/L balance with the carry-forward from the balance service', async () => {
    const row = (period: string, debit: string, credit: string, accumulated: string) => ({ GLAccount: '500030', GLAccountName: 'GR/IR Clearing', LedgerFiscalPeriod: period, DebitAmountInCompanyCodeCrcy: debit, CreditAmountInCoCodeCrcy: credit, AccmltdBalAmtInCoCodeCrcy: accumulated, CompanyCodeCurrency: 'SAR' });
    sdk.reply = () => ({ d: { results: [row('000', '0', '0', '-400.00'), row('009', '3000.00', '-2250.00', '350.00'), row('010', '100.00', '0', '450.00'), row('999', '3100.00', '-2250.00', '450.00')] } });
    const balance = await gateway.getGLBalance(ctx, '500030', '1030', '2026', '9');

    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/FAC_GL_ACCOUNT_BALANCE_SRV/GL_ACCOUNT_BALANCESet');
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: "Ledger eq '0L' and CompanyCode eq '1030' and LedgerFiscalYear eq '2026' and GLAccount eq '500030'" });
    // Period 9: its postings, and the accumulated balance including the carry-forward of -400.
    expect(balance).toMatchObject({ description: 'GR/IR Clearing', period: '009', debit: { amount: 3000 }, credit: { amount: 2250 }, balance: { amount: 350, currency: 'SAR' } });
    expect((await gateway.getGLBalance(ctx, '500030', '1030', '2026')).balance.amount).toBe(450);

    sdk.reply = () => ({ d: { results: [] } });
    await expect(gateway.getGLBalance(ctx, '999999', '1030', '2026')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('applies the period range of the G/L activity itself and searches account names in upper case', async () => {
    const row = (account: string, period: string, debit: string, credit: string) => ({ GLAccount: account, GLAccountName: account, LedgerFiscalPeriod: period, DebitAmountInCompanyCodeCrcy: debit, CreditAmountInCoCodeCrcy: credit, CompanyCodeCurrency: 'SAR' });
    sdk.reply = () => ({ d: { results: [row('700000', '000', '0', '-9'), row('700000', '008', '0', '-100'), row('700000', '009', '0', '-5000'), row('200041', '009', '10000', '0'), row('700000', '999', '0', '-5109')] } });
    expect(await gateway.getAccountActivity(ctx, '1030', '2026', '9', '9')).toEqual([
      { account: '200041', name: '200041', debit: 10000, credit: 0, net: 10000, currency: 'SAR' },
      { account: '700000', name: '700000', debit: 0, credit: 5000, net: -5000, currency: 'SAR' },
    ]);
    expect(sdk.sent[0]!.request.params!.$filter).toBe("Ledger eq '0L' and CompanyCode eq '1030' and LedgerFiscalYear eq '2026'");

    sdk.sent.length = 0;
    sdk.reply = () => ({ d: { results: [{ GLAccountExternal: '220001', GLAccount_Text: 'ALINMA BANK', CompanyCode: '1030', ChartOfAccounts: 'ACGC' }, { GLAccountExternal: '220001', GLAccount_Text: 'ALINMA BANK', CompanyCode: '1030', ChartOfAccounts: 'ACGC' }] } });
    expect(await gateway.searchGLAccounts(ctx, "ba'nk", '1030')).toHaveLength(1);
    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/FAC_GL_DOCUMENT_POST_SRV/FAC_POST_JOUR_ENTRY_GLACCT_VH');
    expect(sdk.sent[0]!.request.params!.$filter).toBe("CompanyCode eq '1030' and substringof('BA''NK',GLAccount_Text)");
  });

  it('ages receivables through the parameterized view and payables from the open supplier items', async () => {
    sdk.reply = () => ({ d: { results: [{ Customer: '7000000010', TotalAmountInDisplayCrcy: '2500', NetDueIntvl2AmtInDspCrcy: '500', NetDueIntvl3AmtInDspCrcy: '0', NetDueIntvl4AmtInDspCrcy: '1000', DisplayCurrency: 'SAR' }, { Customer: '7000000010', TotalAmountInDisplayCrcy: '100' }] } });
    expect(await gateway.getReceivablesAging(ctx, '1030', 'SAR')).toEqual([{ customer: '7000000010', total: 2600, upTo30: 1100, days31to60: 500, days61to90: 0, over90: 1000, currency: 'SAR' }]);
    expect(sdk.sent[0]!.request.url).toBe("/sap/opu/odata/sap/C_ARAGINGANALYSISOVW_CDS/C_ARAGINGANALYSISOVW(P_DisplayCurrency='SAR',P_NetDueInterval1InDays='30',P_NetDueInterval2InDays='60',P_NetDueInterval3InDays='90')/Results");
    await expect(gateway.getReceivablesAging(ctx, '1030', "S'R")).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    sdk.sent.length = 0;
    const item = (dc: string, amount: string, due: number) => ({ Supplier: '7002200010', SupplierName: 'AL-QASSIM', DebitCreditCode: dc, AmountInCompanyCodeCurrency: amount, CompanyCodeCurrency: 'SAR', NetDueDate: `/Date(${due})/` });
    sdk.reply = () => ({ d: { results: [item('H', '-1120.00', Date.UTC(2026, 8, 23)), item('H', '-3360.00', Date.UTC(2026, 9, 20)), item('S', '200.00', Date.UTC(2026, 5, 1))] } });
    const aging = await gateway.getPayablesAging(ctx, '1030', '2026-10-02');
    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/FAP_VENDOR_LINE_ITEMS_SRV/Items');
    expect(sdk.sent[0]!.request.params!.$filter).toBe("CompanyCode eq '1030' and ClearingStatus eq '2'");
    expect(aging.buckets).toEqual([
      { bucket: 'Not due', amount: 3360, items: 1 },
      { bucket: '1-30 days', amount: 1120, items: 1 },
      { bucket: '31-60 days', amount: 0, items: 0 },
      { bucket: '61-90 days', amount: 0, items: 0 },
      { bucket: 'Over 90 days', amount: -200, items: 1 },
    ]);
    expect(aging.suppliers).toEqual([{ supplier: '7002200010', name: 'AL-QASSIM', amount: 4280, overdue: 920, items: 3 }]);
  });

  it('reads the payment run proposal, its items and its exceptions', async () => {
    sdk.reply = (r) => {
      if (r.url.endsWith('PaymentSummarySet')) return { d: { results: [{ PaymentRunId: 'PRW01', PaymentRunIsProposal: true, Currency: 'SAR', AmountInCompanyCodeCurrency: '-1120.00' }] } };
      if (r.url.endsWith('PaymentItemSet')) return { d: { results: [{ PaymentRunId: 'PRW01', Supplier: '7002200010', AccountingDocument: '2001000', NetAmountInCoCodeCurrency: '-1120.00', Currency: 'SAR' }] } };
      return { d: { results: [{ PaymentRunId: 'PRW01', Supplier: '7002200010', AccountingDocument: '2001002', PaymentBlockingReason: 'R', SystemMessageDescription: 'Item is blocked for payment', AmountInTransactionCurrency: '-3900.00', Currency: 'SAR' }] } };
    };
    const proposal = await gateway.getPaymentRunProposal(ctx, '1030', 'PRW01');
    expect(sdk.sent.map((s) => s.request.params!.$filter).sort()).toEqual(["CompanyCode eq '1030' and PaymentRunId eq 'PRW01'", "CompanyCode eq '1030' and PaymentRunId eq 'PRW01'", "PayingCompanyCode eq '1030' and PaymentRunId eq 'PRW01'"]);
    expect(proposal.runs).toEqual([{ runId: 'PRW01', isProposal: true, amount: { amount: 1120, currency: 'SAR' } }]);
    expect(proposal.items[0]).toMatchObject({ document: '2001000', amount: { amount: 1120 } });
    expect(proposal.exceptions[0]).toMatchObject({ blockingReason: 'R', message: 'Item is blocked for payment', amount: { amount: 3900 } });
  });

  it('reads depreciation per asset through the parameterized value views', async () => {
    sdk.reply = (r) => {
      if (r.url.includes('C_FixedAssetMaintain')) return { d: { results: [{ MasterFixedAsset: '100000000010', FixedAsset: '0', FixedAssetDescription: 'Forklift truck' }] } };
      if (r.url.includes('C_FxdAstDeprValueByCrcyRole')) return { d: { results: [{ FiscalPeriod: '009', DepreciationStatus: '2', OrdinaryDeprAmtInDspCrcy: '-1000', Currency: 'SAR' }, { FiscalPeriod: '010', DepreciationStatus: '1', OrdinaryDeprAmtInDspCrcy: '-1000', Currency: 'SAR' }] } };
      return { d: { results: [{ EndingBalAmtInDspCrcy: '48000', Currency: 'SAR' }] } };
    };
    const overview = await gateway.getDepreciationOverview(ctx, '1030', '2026');
    expect(sdk.sent[1]!.request.url).toMatch(/^\/sap\/opu\/odata\/sap\/FAA_ASSET_VALUES_OVERVIEW_SRV\/C_FxdAstDeprValueByCrcyRole\(P_MasterFixedAsset='100000000010',P_FixedAsset='0',P_CompanyCode='1030',P_AssetDepreciationArea='01',P_CurrencyRole='10',P_CreationDateTime=datetimeoffset'\d{4}-\d{2}-\d{2}T00:00:00Z',P_FirstFiscalYear='2026'\)\/Results$/);
    expect(overview.assets).toEqual([{ asset: '100000000010', description: 'Forklift truck', posted: 1000, unposted: 1000, netBookValue: 48000, currency: 'SAR' }]);
    expect(overview.exceptions).toEqual([{ asset: '100000000010', period: '010', status: 'Planned, not yet posted', amount: 1000, currency: 'SAR' }]);
  });

  it('clears the open items of an account through the three steps of the posting service', async () => {
    sdk.reply = (r) => {
      if (r.url.endsWith('CreateClearingForOpenItem')) return { d: { CreateClearingForOpenItem: { TmpId: 'T1', TmpIdType: 'C' } } };
      if (r.url.endsWith('/Post')) return { d: { Post: { AccountingDocument: '1600000001', FiscalYear: '2026', CompanyCode: '1030' } } };
      if (r.url.includes('A_OperationalAcctgDocItemCube')) return { d: { results: [{ CompanyCode: '1030', FiscalYear: '2026', AccountingDocument: '2000016', AccountingDocumentItem: '1', Customer: '7000000010', AmountInCompanyCodeCurrency: '2500', CompanyCodeCurrency: 'SAR' }] } };
      return {};
    };
    expect(await gateway.clearOpenItems(ctx, { companyCode: '1030', accountType: 'CUSTOMER', account: '7000000010' })).toEqual({ document: '1600000001', fiscalYear: '2026', companyCode: '1030' });

    expect(posts().map((r) => r.url.split('/').at(-1))).toEqual(['CreateClearingForOpenItem', 'ActivateItemsToBeCleared', 'Post']);
    expect(posts()[0]!.params).toEqual({ AccountingDocument: "'2000016'", CompanyCode: "'1030'", FiscalYear: "'2026'", AccountingDocumentItem: "'1'", Account: "'7000000010'", FinancialAccountType: "'D'", ClearingTransaction: "'UMBUCHNG'" });
    expect(posts()[1]!.params).toMatchObject({ TmpId: "'T1'", TmpIdType: "'C'", Account: "'7000000010'", FinancialAccountType: "'D'" });
    expect(posts()[2]!.params).toMatchObject({ TmpId: "'T1'", TmpIdType: "'C'" });
    // This gateway protects writes with X-Requested-With.
    expect(posts()[0]!.headers).toMatchObject({ 'x-requested-with': 'XMLHttpRequest' });
  });

  it('posts a journal entry as header, lines and post, and reports when SAP creates no document', async () => {
    const entry = { companyCode: '1030', currency: 'SAR', postingDate: '2026-10-02', headerText: 'Write-off', lines: [{ glAccount: '200041', debitCredit: 'D' as const, amount: 750, costCenter: '10000' }, { glAccount: '200040', debitCredit: 'C' as const, amount: 750 }] };
    let document = '100000001';
    sdk.reply = (r) => {
      if (r.url.endsWith('FinsPostingGLHeaders')) return { d: { TmpId: 'T2', TmpIdType: 'T' } };
      if (r.url.endsWith('/Post')) return { d: { Post: { AccountingDocument: document, FiscalYear: '2026', CompanyCode: '1030' } } };
      return { d: {} };
    };
    expect(await gateway.postJournalEntry(ctx, entry)).toEqual({ document: '100000001', fiscalYear: '2026', companyCode: '1030' });

    expect(posts().map((r) => r.url.split('/').at(-1))).toEqual(['FinsPostingGLHeaders', 'FinsPostingGLItems', 'FinsPostingGLItems', 'Post']);
    expect(posts()[0]!.data).toEqual({ CompanyCode: '1030', AccountingDocumentType: 'SA', DocumentDate: `/Date(${Date.UTC(2026, 9, 2)})/`, PostingDate: `/Date(${Date.UTC(2026, 9, 2)})/`, TransactionCurrency: 'SAR', AccountingDocumentHeaderText: 'Write-off' });
    expect(posts()[1]!.data).toEqual({ TmpId: 'T2', TmpIdType: 'T', AccountingDocumentItemRef: '1', CompanyCode: '1030', GLAccount: '200041', GLAccountForInput: '200041', DebitAmountInTransCrcy: '750.00', CostCenter: '10000', DocumentItemText: 'Write-off' });
    expect(posts()[2]!.data).toMatchObject({ AccountingDocumentItemRef: '2', CreditAmountInTransCrcy: '750.00' });

    document = '';
    await expect(gateway.postJournalEntry(ctx, entry)).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: 'SAP did not post journal entry in company code 1030. Check the document in SAP for the reason.' });
  });
});

describe('OData V2: purchase-to-pay postings', () => {
  const odataDate = expect.stringMatching(/^\/Date\(\d+\)\/$/);
  const purchaseOrder = {
    d: {
      PurchaseOrder: '4200000403',
      Supplier: '7002200010',
      CompanyCode: '1030',
      DocumentCurrency: 'SAR',
      to_PurchaseOrderItem: {
        results: [
          { PurchaseOrderItem: '10', Material: '5496', OrderQuantity: '3', PurchaseOrderQuantityUnit: 'PC', NetPriceAmount: '1000.00' },
          { PurchaseOrderItem: '20', Material: '5497', OrderQuantity: '2', PurchaseOrderQuantityUnit: 'PC', NetPriceAmount: '50.00' },
        ],
      },
    },
  };
  const receipt = (document: string, item: string, quantity: string) => ({ MaterialDocument: document, MaterialDocumentYear: '2026', PurchaseOrderItem: item, QuantityInEntryUnit: quantity, EntryUnit: 'PC' });
  const posted = () => sdk.sent.find((s) => s.request.method === 'post')!;

  it('receives only the quantity that is still open on each order item', async () => {
    let done = false;
    sdk.reply = (r) => {
      if (r.method === 'post') {
        done = true;
        return { d: { MaterialDocument: '5000000012', MaterialDocumentYear: '2026' } };
      }
      if (r.url.includes('A_MaterialDocumentItem')) return { d: { results: [receipt('5000000011', '10', '1'), receipt('5000000011', '20', '2'), ...(done ? [receipt('5000000012', '10', '2')] : [])] } };
      if (r.url.includes('A_PurchaseOrder')) return purchaseOrder;
      return { d: { Supplier: '7002200010', SupplierName: 'AL-QASSIM' } };
    };
    const receipts = await gateway.postGoodsReceipt(ctx, '4200000403');

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader');
    expect(posted().options.fetchCsrfToken).toBe(true);
    expect(posted().request.data).toEqual({
      GoodsMovementCode: '01',
      PostingDate: odataDate,
      DocumentDate: odataDate,
      to_MaterialDocumentItem: {
        results: [{ Material: '5496', GoodsMovementType: '101', GoodsMovementRefDocType: 'B', PurchaseOrder: '4200000403', PurchaseOrderItem: '10', QuantityInEntryUnit: '2', EntryUnit: 'PC' }],
      },
    });
    expect(receipts).toEqual([expect.objectContaining({ materialDocument: '5000000012', item: '10', quantity: 2 })]);
  });

  it('encodes query parameter values, which the SDK would otherwise send as they are', async () => {
    sdk.reply = () => ({ d: { results: [] } });
    await gateway.getGoodsReceipts(ctx, '4200000403');

    const request = sdk.sent[0]!.request as unknown as { params: Record<string, string>; parameterEncoder: (p: Record<string, string>) => Record<string, string> };
    expect(request.parameterEncoder(request.params)).toMatchObject({
      $format: 'json',
      $filter: "PurchaseOrder%20eq%20'4200000403'%20and%20GoodsMovementType%20eq%20'101'",
    });
  });

  it('does not post a goods receipt for an order that is completely received', async () => {
    sdk.reply = (r) => {
      if (r.url.includes('A_MaterialDocumentItem')) return { d: { results: [receipt('5000000011', '10', '3'), receipt('5000000011', '20', '2')] } };
      if (r.url.includes('A_PurchaseOrder')) return purchaseOrder;
      return { d: {} };
    };
    await expect(gateway.postGoodsReceipt(ctx, '4200000403')).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    expect(sdk.sent.some((s) => s.request.method === 'post')).toBe(false);
  });

  it('invoices the received quantity of each order item at the order price', async () => {
    sdk.reply = (r) => {
      if (r.method === 'post') return { d: { SupplierInvoice: '5105600003', FiscalYear: '2026' } };
      if (r.url.includes('A_MaterialDocumentItem')) return { d: { results: [receipt('5000000011', '10', '3')] } };
      if (r.url.includes('A_PurchaseOrder')) return purchaseOrder;
      if (r.url.includes('A_SupplierInvoice')) {
        return { d: { SupplierInvoice: '5105600003', FiscalYear: '2026', CompanyCode: '1030', InvoicingParty: '7002200010', InvoiceGrossAmount: '3360.00', DocumentCurrency: 'SAR', PaymentBlockingReason: 'R', to_SuplrInvcItemPurOrdRef: { results: [{ PurchaseOrder: '4200000403' }] } } };
      }
      return { d: { Supplier: '7002200010', SupplierName: 'AL-QASSIM' } };
    };
    const invoice = await gateway.createSupplierInvoice(ctx, { purchaseOrder: '4200000403', reference: 'VEN004', grossAmount: 3360, invoiceDate: '2026-10-01' });

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice');
    expect(posted().request.data).toEqual({
      CompanyCode: '1030',
      DocumentDate: `/Date(${Date.UTC(2026, 9, 1)})/`,
      PostingDate: odataDate,
      InvoicingParty: '7002200010',
      DocumentCurrency: 'SAR',
      InvoiceGrossAmount: '3360',
      SupplierInvoiceIDByInvcgParty: 'VEN004',
      TaxIsCalculatedAutomatically: true,
      to_SuplrInvcItemPurOrdRef: {
        results: [{ SupplierInvoiceItem: '1', PurchaseOrder: '4200000403', PurchaseOrderItem: '10', DocumentCurrency: 'SAR', SupplierInvoiceItemAmount: '3000', PurchaseOrderQuantityUnit: 'PC', QuantityInPurchaseOrderUnit: '3' }],
      },
    });
    // The block SAP sets during invoice verification is reported, not hidden.
    expect(invoice).toMatchObject({ number: '5105600003', status: 'PAYMENT_BLOCKED', paymentBlock: { code: 'R' } });
    expect(sdk.sent.some((s) => s.request.params?.$expand === 'to_SuplrInvcItemPurOrdRef')).toBe(true);
  });

  it('refuses an invoice before any goods receipt', async () => {
    sdk.reply = (r) => {
      if (r.url.includes('A_MaterialDocumentItem')) return { d: { results: [] } };
      if (r.url.includes('A_PurchaseOrder')) return purchaseOrder;
      return { d: {} };
    };
    await expect(gateway.createSupplierInvoice(ctx, { purchaseOrder: '4200000403', reference: 'VEN004', grossAmount: 3360 })).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    expect(sdk.sent.some((s) => s.request.method === 'post')).toBe(false);
  });

  it('creates a purchase order and leaves the price to the info record unless one is given', async () => {
    sdk.reply = (r) => {
      if (r.method === 'post') return { d: { PurchaseOrder: '4200000404' } };
      if (r.url.includes('A_PurchaseOrder')) return purchaseOrder;
      return { d: { Supplier: '7002200010', SupplierName: 'AL-QASSIM' } };
    };
    const order = { supplier: '7002200010', material: '5496', plant: '1030', quantity: 4, companyCode: '1030', purchasingOrganization: '1030', purchasingGroup: '103' };
    await gateway.createPurchaseOrder(ctx, order);

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder');
    expect(posted().request.data).toEqual({
      PurchaseOrderType: 'NB',
      CompanyCode: '1030',
      PurchasingOrganization: '1030',
      PurchasingGroup: '103',
      Supplier: '7002200010',
      to_PurchaseOrderItem: { results: [{ Material: '5496', Plant: '1030', OrderQuantity: '4' }] },
    });

    sdk.sent.length = 0;
    await gateway.createPurchaseOrder(ctx, { ...order, netPrice: 900 });
    expect((posted().request.data as { to_PurchaseOrderItem: { results: unknown[] } }).to_PurchaseOrderItem.results[0]).toMatchObject({ NetPriceAmount: '900' });
  });

  it('creates a purchase requisition', async () => {
    sdk.reply = (r) => (r.method === 'post' ? { d: { PurchaseRequisition: '10000123' } } : { d: { PurchaseRequisition: '10000123', to_PurchaseReqnItem: { results: [] } } });
    await gateway.createPurchaseRequisition(ctx, { material: '5496', plant: '1030', quantity: 5, deliveryDate: '2026-10-15' });

    expect(posted().request.url).toBe('/sap/opu/odata/sap/API_PURCHASEREQ_PROCESS_SRV/A_PurchaseRequisitionHeader');
    expect(posted().request.data).toEqual({
      PurchaseRequisitionType: 'NB',
      to_PurchaseReqnItem: { results: [{ Material: '5496', Plant: '1030', RequestedQuantity: '5', DeliveryDate: `/Date(${Date.UTC(2026, 9, 15)})/` }] },
    });
  });
});

describe('OData V2: delivery and goods issue', () => {
  it('creates a delivery that references every item of the sales order', async () => {
    sdk.reply = (r) => {
      if (r.method === 'post') return { d: { DeliveryDocument: '80000258' } };
      if (r.url.includes('A_SalesOrder')) return { d: { SalesOrder: '649', SoldToParty: '7000000010', to_Item: { results: [{ SalesOrderItem: '10' }, { SalesOrderItem: '20' }] } } };
      if (r.url.includes('A_OutbDeliveryHeader')) return { d: { DeliveryDocument: '80000258', ShipToParty: '7000000010', OverallGoodsMovementStatus: 'A', to_DeliveryDocumentItem: { results: [] } } };
      return { d: { Customer: '7000000010', CustomerName: 'Local Customer-01' } };
    };
    const delivery = await gateway.createDelivery(ctx, '649');

    const post = sdk.sent.find((s) => s.request.method === 'post')!;
    expect(post.request.url).toBe('/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryHeader');
    // No query options on a POST: SAP Gateway rejects $format there.
    expect(post.request.params).toBeUndefined();
    expect(post.request.data).toEqual({
      to_DeliveryDocumentItem: { results: [{ ReferenceSDDocument: '649', ReferenceSDDocumentItem: '10' }, { ReferenceSDDocument: '649', ReferenceSDDocumentItem: '20' }] },
    });
    expect(delivery).toMatchObject({ number: '80000258', goodsIssueStatus: 'NOT_STARTED' });
  });

  it('posts goods issue with an ETag and escapes the document key', async () => {
    sdk.reply = (r) => (r.url.includes('A_OutbDeliveryHeader') ? { d: { DeliveryDocument: '80000258', OverallGoodsMovementStatus: 'C', to_DeliveryDocumentItem: { results: [] } } } : {});
    const delivery = await gateway.postGoodsIssue(ctx, "8000'0258");

    const post = sdk.sent[0]!;
    expect(post.request.url).toBe('/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/PostGoodsIssue');
    expect(post.request.params).toMatchObject({ DeliveryDocument: "'8000''0258'" });
    expect(post.request.headers).toMatchObject({ 'if-match': '*' });
    expect(delivery.goodsIssueStatus).toBe('COMPLETE');
  });

  it('reads the V2 error text of a rejected posting, but keeps read errors generic', async () => {
    sdk.reply = () => {
      throw rejected(400, { error: { message: { lang: 'en', value: 'Batch is missing for item 10' } } });
    };
    await expect(gateway.postGoodsIssue(ctx, '80000258')).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: 'SAP rejected Goods issue for delivery 80000258: Batch is missing for item 10' });
    await expect(gateway.getDelivery(ctx, '80000258')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'SAP rejected the request for Outbound delivery 80000258.' });
  });

  it('maps authorization and availability failures for purchasing postings too', async () => {
    sdk.reply = () => {
      throw rejected(403, {});
    };
    await expect(gateway.createPurchaseOrder(ctx, { supplier: '7002200010', material: '5496', plant: '1030', quantity: 1, companyCode: '1030', purchasingOrganization: '1030', purchasingGroup: '103' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('maps authorization and availability failures', async () => {
    sdk.reply = () => {
      throw rejected(403, {});
    };
    await expect(gateway.createBillingDocument(ctx, '80000258')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    sdk.reply = () => {
      throw rejected(503, {});
    };
    await expect(gateway.createBillingDocument(ctx, '80000258')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });

  it('refuses to call SAP without an end-user identity', async () => {
    await expect(gateway.postGoodsReceipt({ principal: { sub: 'u' }, correlationId: 'c' } as never, '4200000403')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(gateway.createBillingDocument({ principal: { sub: 'u' }, correlationId: 'c' } as never, '80000258')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(sdk.sent).toHaveLength(0);
  });
});

describe('vendor addresses', () => {
  const partner = (n: number, address: Record<string, string> = {}) => ({
    BusinessPartner: String(n),
    BusinessPartnerFullName: `Vendor ${n}`,
    Customer: n === 2 ? '2' : '',
    Supplier: n === 3 ? 'VENDMAH3' : String(n),
    to_BusinessPartnerAddress: { results: [{ StreetName: '', HouseNumber: '', CityName: '', PostalCode: '', Region: '', Country: 'IN', ...address }] },
  });

  it('reads suppliers page by page until SAP has no more', async () => {
    const pages = [
      { d: { results: [partner(1, { StreetName: ' LBS NAGAR ', CityName: 'BANGALORE', PostalCode: '560075', Region: '10' }), partner(2)], __next: 'more' } },
      { d: { results: [partner(3, { CityName: 'Nashik' })] } },
    ];
    sdk.reply = () => pages.shift();
    const vendors = await gateway.listVendorAddresses(ctx);

    expect(sdk.sent).toHaveLength(2);
    expect(sdk.sent[0]!.request.url).toBe('/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner');
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: "Supplier ne ''", $expand: 'to_BusinessPartnerAddress', $skip: '0' });
    expect(sdk.sent[1]!.request.params).toMatchObject({ $skip: '2' });
    expect(vendors).toEqual([
      { id: '1', businessPartner: '1', name: 'Vendor 1', isCustomer: false, street: 'LBS NAGAR', city: 'BANGALORE', postalCode: '560075', region: '10', country: 'IN' },
      // Empty address fields are left out, and a supplier number need not be numeric.
      { id: '2', businessPartner: '2', name: 'Vendor 2', isCustomer: true, country: 'IN' },
      { id: 'VENDMAH3', businessPartner: '3', name: 'Vendor 3', isCustomer: false, city: 'Nashik', country: 'IN' },
    ]);
  });
});
