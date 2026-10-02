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
    expect(post.request.params).toEqual({ $format: 'json' });
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
    await expect(gateway.createBillingDocument({ principal: { sub: 'u' }, correlationId: 'c' } as never, '80000258')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(sdk.sent).toHaveLength(0);
  });
});
