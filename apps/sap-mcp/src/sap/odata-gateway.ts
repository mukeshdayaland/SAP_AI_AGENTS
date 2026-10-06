import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { M, type Logger } from '@prowess/observability';
import {
  SapError,
  AGING_BUCKETS,
  type AccountActivity,
  type AccountingDocument,
  type BankReconciliationAccount,
  type BillingDocument,
  type ClearingRequest,
  type CreditMemoRequest,
  type CreditProfile,
  type Customer,
  type DepreciationOverview,
  type DocumentFlowStep,
  type Equipment,
  type GLAccountInfo,
  type GLBalance,
  type GRIRCase,
  type GoodsReceipt,
  type InfoRecord,
  type Invoice,
  type InvoiceApproval,
  type MaintenanceEvent,
  type MaintenanceNotification,
  type MaterialStock,
  type NewJournalEntry,
  type NewPurchaseOrder,
  type NewPaymentRequest,
  type NewPurchaseRequisition,
  type NewSalesOrder,
  type NewSupplierInvoice,
  type OpenItem,
  type OpenItemQuery,
  type OutboundDelivery,
  type PayablesAging,
  type PaymentRequest,
  type PaymentRequestQuery,
  type PaymentRunProposal,
  type PaymentStatus,
  type PostedDocument,
  type ProcessStatus,
  type PurchaseOrder,
  type PurchaseRequisition,
  type ReceivablesAging,
  type Reversal,
  type SalesOrder,
  type SalesOrderChange,
  type IncompletionEntry,
  type SalesOrderSimulation,
  type SapCallContext,
  type SapGateway,
  type SearchHit,
  type SystemInfo,
  type Vendor,
  type VendorAddress,
  type WorkOrder,
} from './model.js';

/**
 * S/4HANA gateway over released OData APIs (V2, and V4 where an API only
 * exists as a RAP service), reached through the BTP
 * Destination service (and the Connectivity service + Cloud Connector for
 * on-premise systems). Uses the SAP Cloud SDK, which handles destination
 * lookup, OAuth/SAML token flows, the connectivity proxy and CSRF tokens.
 *
 * Identity: when a user JWT is present it is passed to the SDK, so
 * destinations configured with `PrincipalPropagation` (on-premise) or
 * `OAuth2SAMLBearerAssertion` / `OAuth2JWTBearer` (cloud) execute as the end
 * user and S/4HANA enforces that user's authorizations. Without a user JWT
 * the call is refused unless technical-user mode is explicitly enabled —
 * see docs/sap-connectivity.md for the security implications.
 *
 * Field mappings follow the published API definitions on the SAP Business
 * Accelerator Hub and must be validated against the target S/4HANA release.
 */

export interface ODataGatewayConfig {
  destinationName: string;
  systemId: string;
  /** Allows calls without an end-user token (technical user). Off by default. */
  allowTechnicalUser: boolean;
  logger: Logger;
}

const SERVICES = {
  invoice: '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV',
  bp: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
  po: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
  pr: '/sap/opu/odata/sap/API_PURCHASEREQ_PROCESS_SRV',
  gr: '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV',
  equipment: '/sap/opu/odata/sap/API_EQUIPMENT',
  notification: '/sap/opu/odata/sap/API_MAINTNOTIFICATION',
  order: '/sap/opu/odata/sap/API_MAINTENANCEORDER',
  salesOrder: '/sap/opu/odata/sap/API_SALES_ORDER_SRV',
  delivery: '/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002',
  billing: '/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV',
  lineItems: '/sap/opu/odata/sap/API_OPLACCTGDOCITEMCUBE_SRV',
  journal: '/sap/opu/odata/sap/API_JOURNALENTRYITEMBASIC_SRV',
  credit: '/sap/opu/odata/sap/API_CRDTMBUSINESSPARTNER',
  stock: '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV',
  infoRecord: '/sap/opu/odata/sap/API_INFORECORD_PROCESS_SRV',
  // OData V4 (RAP service binding): <binding>/srvd/sap/<service definition>/<version>
  billingV4: '/sap/opu/odata4/sap/api_billingdocument/srvd/sap/api_billingdocument/0001',
  // Custom RAP service ZAPI_FI_AGENTPAYMENT (package ZODATA): payment requests with second-person approval.
  payment: '/sap/opu/odata4/sap/zapi_fi_agentpayment_o4/srvd/sap/zapi_fi_agentpayment/0001',
  // Custom read-only service on the incompletion log (VBUV); not in the released sales order API.
  incompletion: '/sap/opu/odata4/sap/zapi_sd_incompletionlog_o4/srvd/sap/zapi_sd_incompletionlog/0001',
  salesSimulation: '/sap/opu/odata/sap/API_SALES_ORDER_SIMULATION_SRV',
  // Finance analysis: Fiori application services, verified on this S/4HANA 2023 system.
  glBalance: '/sap/opu/odata/sap/FAC_GL_ACCOUNT_BALANCE_SRV',
  glPost: '/sap/opu/odata/sap/FAC_GL_DOCUMENT_POST_SRV',
  arAging: '/sap/opu/odata/sap/C_ARAGINGANALYSISOVW_CDS',
  supplierItems: '/sap/opu/odata/sap/FAP_VENDOR_LINE_ITEMS_SRV',
  invoiceList: '/sap/opu/odata/sap/MM_SUPPLIER_INVOICE_LIST_ENH_SRV',
  paymentProposal: '/sap/opu/odata/sap/FAP_SCHEDULE_PAYMENT_PROPOSAL',
  grir: '/sap/opu/odata/sap/FAC_GRIR_ANALYSIS_SRV',
  bankReconciliation: '/sap/opu/odata/sap/FAR_BS_ITM_REPROC_SRV',
  assets: '/sap/opu/odata/sap/FAA_ASSET_MANAGE_SRV',
  assetValues: '/sap/opu/odata/sap/FAA_ASSET_VALUES_OVERVIEW_SRV',
  creditMemo: '/sap/opu/odata/sap/API_CREDIT_MEMO_REQUEST_SRV',
} as const;

/** Price condition types: PPR0 in S/4HANA pricing procedures, PR00 in classic ones such as RVAA01. */
const PRICE_CONDITIONS = ['PPR0', 'PR00'];

const PAYMENT_STATUS: Record<string, PaymentStatus> = { N: 'NEW', A: 'APPROVED', P: 'POSTED', R: 'REJECTED' };
const PAYMENT_STATUS_CODE: Record<PaymentStatus, string> = { NEW: 'N', APPROVED: 'A', POSTED: 'P', REJECTED: 'R' };

/** OData V4 key of a payment request. Anything but a UUID is refused, which also prevents path injection. */
function paymentKey(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new SapError('INVALID_INPUT', 'The payment request id is not valid.');
  return `Payment(${id.toLowerCase()})`;
}

/** OData V2 date-time literal for function import parameters. */
const dateTimeLit = (isoDate: string) => `datetime'${isoDate}T00:00:00'`;

/** Line-item fields read from the operational accounting document item cube. */
const LINE_ITEM_FIELDS = [
  'CompanyCode',
  'FiscalYear',
  'AccountingDocument',
  'AccountingDocumentItem',
  'AccountingDocumentType',
  'Customer',
  'Supplier',
  'GLAccount',
  'PostingDate',
  'NetDueDate',
  'AmountInCompanyCodeCurrency',
  'CompanyCodeCurrency',
  'ClearingAccountingDocument',
  'ClearingDate',
  'AssignmentReference',
  'DocumentItemText',
  'PaymentBlockingReason',
].join(',');

/** SAP's financial account type: D = customer, K = supplier, S = G/L account. */
const ACCOUNT_TYPE = { CUSTOMER: { code: 'D', field: 'Customer' }, SUPPLIER: { code: 'K', field: 'Supplier' }, GL: { code: 'S', field: 'GLAccount' } } as const;

/** SD status: '' not relevant, A not yet processed, B partially processed, C completely processed. */
const processStatus = (v: unknown): ProcessStatus => (v === 'C' ? 'COMPLETE' : v === 'B' ? 'PARTIAL' : v === 'A' ? 'NOT_STARTED' : 'NOT_RELEVANT');

/** Follow-on document categories in the SD document flow. */
const FLOW_CATEGORY: Record<string, DocumentFlowStep['category']> = { J: 'DELIVERY', T: 'DELIVERY', R: 'GOODS_ISSUE', M: 'BILLING', N: 'BILLING', O: 'BILLING', P: 'BILLING' };

/** Suppliers are read in pages; the page limit caps one map load at 10,000 suppliers. */
const VENDOR_PAGE_SIZE = 500;
const VENDOR_MAX_PAGES = 20;
const VENDOR_ADDRESS_FIELDS = ['StreetName', 'HouseNumber', 'CityName', 'PostalCode', 'Region', 'Country'];

const results = (v: unknown) => ((v as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];
const str = (v: unknown) => String(v ?? '').trim();

/** OData V2 key literal with quotes escaped — prevents key/path injection. */
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

/** `/Date(1695000000000)/` → `2023-09-18` */
function odataDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = /\/Date\((-?\d+)/.exec(v)?.[1];
  if (ms) return new Date(Number(ms)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}

/** OData V2 date literal for request bodies: `2026-10-02` -> `/Date(1790899200000)/`. */
const toODataDate = (isoDate: string) => `/Date(${Date.parse(`${isoDate}T00:00:00Z`)})/`;
const todayIso = () => new Date().toISOString().slice(0, 10);

const encodeParameterValues = (params: Record<string, unknown>) => Object.fromEntries(Object.entries(params).map(([key, value]) => [key, encodeURIComponent(String(value))]));

const round2 = (v: number) => Math.round(v * 100) / 100;
const isTrue = (v: unknown) => v === true || v === 'true' || v === 'X';
/** Whole days from a date (YYYY-MM-DD) to the key date; positive when the date is in the past. */
const daysBetween = (date: string, keyDate: string) => Math.floor((Date.parse(`${keyDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
/** Depreciation status codes of FI-AA that mean the period is posted. */
const DEPRECIATION_POSTED = new Set(['2', '3', 'P']);
/** Fixed assets examined per depreciation overview: each one needs two reads. */
const MAX_ASSETS = 20;

const num = (v: unknown) => (typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0')) || 0);

function statusOf(err: unknown): number | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const status = (e as { response?: { status?: number } }).response?.status ?? (e as { status?: number }).status;
    if (typeof status === 'number') return status;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The message SAP returned with an error, if any: `error.message.value` in
 * OData V2, `error.message` in V4. It is SAP's own text for the calling user
 * (for example "Delivery 80000258 has not been goods issued").
 */
function sapMessageOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const message = (e as { response?: { data?: { error?: { message?: unknown } } } }).response?.data?.error?.message;
    const text = typeof message === 'string' ? message : (message as { value?: unknown } | undefined)?.value;
    if (typeof text === 'string' && text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 300);
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SAP's error body (message ID, details, inner error), shortened for the log. */
function sapErrorBodyOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const body = (e as { response?: { data?: { error?: unknown } } }).response?.data?.error;
    if (body) return JSON.stringify(body).slice(0, 2000);
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

type ODataEntity = Record<string, unknown>;

export class ODataSapGateway implements SapGateway {
  readonly mock = false;

  constructor(private readonly cfg: ODataGatewayConfig) {}

  get systemId() {
    return this.cfg.systemId;
  }

  private destination(ctx: SapCallContext) {
    if (!ctx.userJwt && !this.cfg.allowTechnicalUser) {
      throw new SapError('NOT_AUTHORIZED', 'No end-user identity is available for SAP principal propagation; the request was refused.');
    }
    return { destinationName: this.cfg.destinationName, ...(ctx.userJwt && { jwt: ctx.userJwt }) };
  }

  /** OData V2 request. Returns the payload inside the `d` envelope. */
  private async request(
    ctx: SapCallContext,
    what: string,
    method: 'get' | 'post' | 'patch',
    url: string,
    params?: Record<string, string>,
    write?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<unknown> {
    // SAP Gateway rejects system query options such as $format on a POST; the Accept header asks for JSON there.
    const data = await this.send(ctx, what, method, url, method === 'get' ? { $format: 'json', ...params } : params, write);
    return (data as { d?: unknown }).d ?? data;
  }

  /** OData V4 request. V4 has no `d` envelope and takes no `$format`; collections arrive as `{ value: [...] }`. */
  private requestV4(
    ctx: SapCallContext,
    what: string,
    method: 'get' | 'post',
    url: string,
    options: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    return this.send(ctx, what, method, url, options.params, { ...(options.body !== undefined && { body: options.body }), headers: { 'content-type': 'application/json', ...options.headers } });
  }

  private async send(
    ctx: SapCallContext,
    what: string,
    method: 'get' | 'post' | 'patch',
    url: string,
    params?: Record<string, string>,
    write?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<unknown> {
    const started = Date.now();
    try {
      const res = await executeHttpRequest(
        this.destination(ctx),
        {
          method,
          url,
          // The SDK sends parameters of a plain request config as they are, so $filter values must be encoded here.
          ...(params && { params, parameterEncoder: encodeParameterValues }),
          ...(write?.body !== undefined && { data: write.body }),
          // This gateway protects writes with X-Requested-With; it does not always issue a CSRF token.
          headers: { accept: 'application/json', 'x-correlation-id': ctx.correlationId, ...(method !== 'get' && { 'x-requested-with': 'XMLHttpRequest' }), ...write?.headers },
          timeout: 20_000,
        },
        { fetchCsrfToken: method !== 'get' },
      );
      return res.data;
    } catch (err) {
      if (err instanceof SapError) throw err;
      const status = statusOf(err);
      const sapMessage = sapMessageOf(err);
      const sapError = sapErrorBodyOf(err);
      // SAP's own message and error body are logged so a rejected posting can be diagnosed from the logs.
      this.cfg.logger.warn('sap.request_failed', { what, method, status, error: (err as Error).message, ...(sapMessage && { sapMessage }), ...(sapError && { sapError }) });
      if (status === 404) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
      if (status === 401 || status === 403) throw new SapError('NOT_AUTHORIZED', `SAP denied access to ${what}.`);
      // A rejected posting is a business outcome the user must be able to act on, so SAP's reason is passed on.
      if (status === 400 && method !== 'get' && sapMessage) throw new SapError('BUSINESS_RULE', `SAP rejected ${what}: ${sapMessage}`);
      if (status === 400) throw new SapError('INVALID_INPUT', `SAP rejected the request for ${what}.`);
      throw new SapError('UNAVAILABLE', `SAP is not reachable right now (${what}).`, true);
    } finally {
      M.sapDuration().observe({ system: this.systemId, method }, Date.now() - started);
    }
  }

  private notSupported(what: string): never {
    throw new SapError('NOT_SUPPORTED', `${what} is not available through the configured S/4HANA APIs.`);
  }

  async systemInfo(): Promise<SystemInfo> {
    return { systemId: this.systemId, description: `S/4HANA via destination ${this.cfg.destinationName}`, release: 'n/a', mock: false };
  }

  async getInvoice(ctx: SapCallContext, number: string, fiscalYear?: string): Promise<Invoice> {
    const what = `Supplier invoice ${number}`;
    let e: ODataEntity;
    if (fiscalYear) {
      e = (await this.request(ctx, what, 'get', `${SERVICES.invoice}/A_SupplierInvoice(SupplierInvoice=${lit(number)},FiscalYear=${lit(fiscalYear)})`, {
        $expand: 'to_SuplrInvcItemPurOrdRef',
      })) as ODataEntity;
    } else {
      const res = (await this.request(ctx, what, 'get', `${SERVICES.invoice}/A_SupplierInvoice`, {
        $filter: `SupplierInvoice eq ${lit(number)}`,
        $orderby: 'FiscalYear desc',
        $top: '1',
        $expand: 'to_SuplrInvcItemPurOrdRef',
      })) as { results?: ODataEntity[] };
      const first = res.results?.[0];
      if (!first) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
      e = first;
    }
    const block = String(e.PaymentBlockingReason ?? '').trim();
    const poRefs = ((e.to_SuplrInvcItemPurOrdRef as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];
    const vendorId = String(e.InvoicingParty ?? '');
    const vendorName = vendorId ? await this.getVendor(ctx, vendorId).then((v) => v.name, () => vendorId) : '';
    return {
      number: String(e.SupplierInvoice),
      fiscalYear: String(e.FiscalYear),
      companyCode: String(e.CompanyCode ?? ''),
      vendorId,
      vendorName,
      gross: { amount: num(e.InvoiceGrossAmount), currency: String(e.DocumentCurrency ?? '') },
      ...(odataDate(e.PostingDate) && { postingDate: odataDate(e.PostingDate) }),
      ...(odataDate(e.DueCalculationBaseDate) && { dueDate: odataDate(e.DueCalculationBaseDate) }),
      status: block ? 'PAYMENT_BLOCKED' : e.SupplierInvoiceStatus === 'A' ? 'PARKED' : 'OPEN',
      paymentBlock: block ? { code: block, description: block === 'R' ? 'Invoice verification' : `Payment block ${block}` } : null,
      ...(poRefs[0]?.PurchaseOrder ? { purchaseOrder: String(poRefs[0].PurchaseOrder) } : {}),
    };
  }

  async getVendor(ctx: SapCallContext, id: string): Promise<Vendor> {
    const e = (await this.request(ctx, `Supplier ${id}`, 'get', `${SERVICES.bp}/A_Supplier(${lit(id)})`)) as ODataEntity;
    return {
      id: String(e.Supplier),
      name: String(e.SupplierName ?? e.Supplier),
      country: String(e.Country ?? ''),
      ...(e.CityName ? { city: String(e.CityName) } : {}),
      postingBlocked: e.PostingIsBlocked === true,
      paymentBlocked: e.PaymentIsBlockedForSupplier === true,
    };
  }

  async listVendorAddresses(ctx: SapCallContext): Promise<VendorAddress[]> {
    const vendors: VendorAddress[] = [];
    for (let page = 0; page < VENDOR_MAX_PAGES; page++) {
      const d = (await this.request(ctx, 'Suppliers', 'get', `${SERVICES.bp}/A_BusinessPartner`, {
        $filter: "Supplier ne ''",
        $expand: 'to_BusinessPartnerAddress',
        $select: `BusinessPartner,BusinessPartnerFullName,Customer,Supplier,${VENDOR_ADDRESS_FIELDS.map((f) => `to_BusinessPartnerAddress/${f}`).join(',')}`,
        $orderby: 'BusinessPartner',
        $top: String(VENDOR_PAGE_SIZE),
        $skip: String(vendors.length),
      })) as { results?: ODataEntity[]; __next?: string };
      const rows = d.results ?? [];
      for (const e of rows) {
        const a = results(e.to_BusinessPartnerAddress)[0] ?? {};
        vendors.push({
          id: str(e.Supplier),
          businessPartner: str(e.BusinessPartner),
          name: str(e.BusinessPartnerFullName) || str(e.Supplier),
          isCustomer: str(e.Customer) !== '',
          ...(str(a.StreetName) && { street: str(a.StreetName) }),
          ...(str(a.HouseNumber) && { houseNumber: str(a.HouseNumber) }),
          ...(str(a.CityName) && { city: str(a.CityName) }),
          ...(str(a.PostalCode) && { postalCode: str(a.PostalCode) }),
          ...(str(a.Region) && { region: str(a.Region) }),
          country: str(a.Country),
        });
      }
      // SAP may return fewer rows than asked for and point to the rest with __next.
      if (!rows.length || (rows.length < VENDOR_PAGE_SIZE && !d.__next)) break;
    }
    return vendors;
  }

  /**
   * Balance of a G/L account from the G/L account balance service (leading ledger 0L).
   * The service returns one row per period plus period 000 (balance carried forward) and 999 (year total).
   */
  async getGLBalance(ctx: SapCallContext, account: string, companyCode: string, fiscalYear: string, period?: string): Promise<GLBalance> {
    const rows = results(
      await this.request(ctx, `G/L account ${account}`, 'get', `${SERVICES.glBalance}/GL_ACCOUNT_BALANCESet`, {
        $select: 'GLAccount,GLAccountName,LedgerFiscalPeriod,DebitAmountInCompanyCodeCrcy,CreditAmountInCoCodeCrcy,BalAmtInCompanyCodeCrcy,AccmltdBalAmtInCoCodeCrcy,CompanyCodeCurrency',
        $filter: `Ledger eq '0L' and CompanyCode eq ${lit(companyCode)} and LedgerFiscalYear eq ${lit(fiscalYear)} and GLAccount eq ${lit(account)}`,
        $top: '200',
      }),
    );
    if (!rows.length) throw new SapError('NOT_FOUND', `No balance was found in SAP for G/L account ${account} in company code ${companyCode}, fiscal year ${fiscalYear}.`);
    const currency = str(rows.find((r) => str(r.CompanyCodeCurrency))?.CompanyCodeCurrency);
    const periodOf = (r: ODataEntity) => str(r.LedgerFiscalPeriod).padStart(3, '0');
    const wanted = period?.padStart(3, '0');
    const postings = rows.filter((r) => periodOf(r) !== '000' && periodOf(r) !== '999' && (!wanted || periodOf(r) <= wanted)).sort((x, y) => periodOf(x).localeCompare(periodOf(y)));
    const sum = (field: string) => postings.reduce((total, r) => total + Math.abs(num(r[field])), 0);
    // The accumulated balance of the last period read includes the balance carried forward.
    const closing = postings.at(-1) ?? rows.find((r) => periodOf(r) === '000');
    return {
      account,
      description: str(rows.find((r) => str(r.GLAccountName))?.GLAccountName) || `G/L account ${account}`,
      companyCode,
      fiscalYear,
      period: wanted ?? (postings.length ? periodOf(postings.at(-1)!) : '000'),
      debit: { amount: round2(sum('DebitAmountInCompanyCodeCrcy')), currency },
      credit: { amount: round2(sum('CreditAmountInCoCodeCrcy')), currency },
      balance: { amount: round2(num(closing?.AccmltdBalAmtInCoCodeCrcy)), currency },
    };
  }

  async getPurchaseOrder(ctx: SapCallContext, number: string): Promise<PurchaseOrder> {
    const e = (await this.request(ctx, `Purchase order ${number}`, 'get', `${SERVICES.po}/A_PurchaseOrder(${lit(number)})`, {
      $expand: 'to_PurchaseOrderItem',
    })) as ODataEntity;
    const items = ((e.to_PurchaseOrderItem as { results?: ODataEntity[] } | undefined)?.results ?? []).map((i) => {
      const currency = String(i.DocumentCurrency ?? e.DocumentCurrency ?? '');
      return {
        item: String(i.PurchaseOrderItem),
        material: String(i.Material ?? ''),
        description: String(i.PurchaseOrderItemText ?? ''),
        quantity: num(i.OrderQuantity),
        unit: String(i.PurchaseOrderQuantityUnit ?? ''),
        netPrice: { amount: num(i.NetPriceAmount), currency },
        netValue: { amount: num(i.NetPriceAmount) * num(i.OrderQuantity), currency },
      };
    });
    const currency = String(e.DocumentCurrency ?? '');
    const vendorId = String(e.Supplier ?? '');
    return {
      number: String(e.PurchaseOrder),
      vendorId,
      vendorName: await this.getVendor(ctx, vendorId).then((v) => v.name, () => vendorId),
      value: { amount: items.reduce((s, i) => s + i.netValue.amount, 0), currency },
      status: e.ReleaseIsNotCompleted === true ? 'AWAITING_APPROVAL' : 'RELEASED',
      createdOn: odataDate(e.CreationDate) ?? '',
      ...(e.PurchasingGroup ? { purchasingGroup: String(e.PurchasingGroup) } : {}),
      companyCode: String(e.CompanyCode ?? ''),
      items,
    };
  }

  async getPurchaseRequisition(ctx: SapCallContext, number: string): Promise<PurchaseRequisition> {
    const e = (await this.request(ctx, `Purchase requisition ${number}`, 'get', `${SERVICES.pr}/A_PurchaseRequisitionHeader(${lit(number)})`, {
      $expand: 'to_PurchaseReqnItem',
    })) as ODataEntity;
    const items = ((e.to_PurchaseReqnItem as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];
    const first = items[0];
    return {
      number: String(e.PurchaseRequisition),
      requester: String(first?.RequisitionerName ?? first?.CreatedByUser ?? ''),
      value: {
        amount: items.reduce((s, i) => s + num(i.PurchaseRequisitionPrice) * num(i.RequestedQuantity), 0),
        currency: String(first?.PurReqnItemCurrency ?? ''),
      },
      status: 'OPEN',
      createdOn: odataDate(first?.CreationDate) ?? '',
      description: String(e.PurReqnDescription ?? first?.PurchaseRequisitionItemText ?? ''),
    };
  }

  async getGoodsReceipts(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]> {
    const res = (await this.request(ctx, `Goods receipts for ${purchaseOrder}`, 'get', `${SERVICES.gr}/A_MaterialDocumentItem`, {
      $filter: `PurchaseOrder eq ${lit(purchaseOrder)} and GoodsMovementType eq '101'`,
      $top: '100',
    })) as { results?: ODataEntity[] };
    return (res.results ?? []).map((i) => ({
      materialDocument: String(i.MaterialDocument),
      year: String(i.MaterialDocumentYear),
      purchaseOrder,
      item: String(i.PurchaseOrderItem ?? ''),
      postingDate: odataDate(i.PostingDate) ?? '',
      quantity: num(i.QuantityInEntryUnit),
      unit: String(i.EntryUnit ?? ''),
    }));
  }

  async getEquipment(ctx: SapCallContext, number: string): Promise<Equipment> {
    const e = (await this.request(ctx, `Equipment ${number}`, 'get', `${SERVICES.equipment}/Equipment(${lit(number)})`)) as ODataEntity;
    return {
      number: String(e.Equipment),
      description: String(e.EquipmentName ?? ''),
      ...(e.FunctionalLocation ? { functionalLocation: String(e.FunctionalLocation) } : {}),
      ...(e.AssetManufacturerName ? { manufacturer: String(e.AssetManufacturerName) } : {}),
      status: String(e.EquipmentSystemStatus ?? e.EquipmentUserStatus ?? 'n/a'),
    };
  }

  async getNotification(ctx: SapCallContext, number: string): Promise<MaintenanceNotification> {
    const e = (await this.request(ctx, `Notification ${number}`, 'get', `${SERVICES.notification}/MaintenanceNotification(${lit(number)})`)) as ODataEntity;
    return {
      number: String(e.MaintenanceNotification),
      type: String(e.NotificationType ?? ''),
      description: String(e.NotificationText ?? ''),
      ...(e.TechnicalObject ? { equipment: String(e.TechnicalObject) } : {}),
      priority: String(e.MaintPriorityDesc ?? e.MaintPriority ?? ''),
      status: String(e.MaintNotifProcessingPhaseDesc ?? e.NotifProcessingPhase ?? ''),
      reportedOn: odataDate(e.NotificationCreationDate) ?? '',
    };
  }

  async getWorkOrder(ctx: SapCallContext, number: string): Promise<WorkOrder> {
    const e = (await this.request(ctx, `Maintenance order ${number}`, 'get', `${SERVICES.order}/MaintenanceOrder(${lit(number)})`)) as ODataEntity;
    return {
      number: String(e.MaintenanceOrder),
      description: String(e.MaintenanceOrderDesc ?? ''),
      ...(e.Equipment ? { equipment: String(e.Equipment) } : {}),
      orderType: String(e.MaintenanceOrderType ?? ''),
      priority: String(e.MaintPriorityDesc ?? e.MaintPriority ?? ''),
      status: String(e.MaintOrdProcessingPhaseDesc ?? e.MaintOrdProcessingPhase ?? ''),
      ...(odataDate(e.MaintOrdBasicStartDate) && { plannedStart: odataDate(e.MaintOrdBasicStartDate) }),
      ...(odataDate(e.MaintOrdBasicEndDate) && { plannedEnd: odataDate(e.MaintOrdBasicEndDate) }),
    };
  }

  async getMaintenanceHistory(ctx: SapCallContext, equipment: string): Promise<MaintenanceEvent[]> {
    const [notifs, orders] = await Promise.all([
      this.request(ctx, `Notifications for ${equipment}`, 'get', `${SERVICES.notification}/MaintenanceNotification`, {
        $filter: `TechnicalObject eq ${lit(equipment)}`,
        $orderby: 'NotificationCreationDate desc',
        $top: '50',
      }) as Promise<{ results?: ODataEntity[] }>,
      this.request(ctx, `Orders for ${equipment}`, 'get', `${SERVICES.order}/MaintenanceOrder`, {
        $filter: `Equipment eq ${lit(equipment)}`,
        $orderby: 'MaintOrdBasicStartDate desc',
        $top: '50',
      }) as Promise<{ results?: ODataEntity[] }>,
    ]);
    const events: MaintenanceEvent[] = [
      ...(notifs.results ?? []).map((n) => ({
        date: odataDate(n.NotificationCreationDate) ?? '',
        kind: 'NOTIFICATION' as const,
        reference: String(n.MaintenanceNotification),
        title: String(n.NotificationText ?? ''),
      })),
      ...(orders.results ?? []).map((o) => ({
        date: odataDate(o.MaintOrdBasicStartDate) ?? '',
        kind: 'WORK_ORDER' as const,
        reference: String(o.MaintenanceOrder),
        title: String(o.MaintenanceOrderDesc ?? ''),
      })),
    ];
    return events.sort((a, b) => a.date.localeCompare(b.date));
  }

  async search(): Promise<SearchHit[]> {
    return this.notSupported('Free-text search (connect SAP Enterprise Search or a search CDS view)');
  }

  private mapSalesOrder(e: ODataEntity, soldToName: string): SalesOrder {
    const currency = str(e.TransactionCurrency);
    const credit = str(e.TotalCreditCheckStatus);
    return {
      number: str(e.SalesOrder),
      orderType: str(e.SalesOrderType),
      salesOrganization: str(e.SalesOrganization),
      distributionChannel: str(e.DistributionChannel),
      division: str(e.OrganizationDivision),
      soldTo: str(e.SoldToParty),
      soldToName,
      ...(str(e.PurchaseOrderByCustomer) && { customerReference: str(e.PurchaseOrderByCustomer) }),
      netValue: { amount: num(e.TotalNetAmount), currency },
      ...(odataDate(e.CreationDate) && { createdOn: odataDate(e.CreationDate) }),
      ...(odataDate(e.RequestedDeliveryDate) && { requestedDeliveryDate: odataDate(e.RequestedDeliveryDate) }),
      ...(str(e.CustomerPaymentTerms) && { paymentTerms: str(e.CustomerPaymentTerms) }),
      ...(str(e.IncotermsClassification) && { incoterms: str(e.IncotermsClassification) }),
      deliveryStatus: processStatus(e.OverallDeliveryStatus),
      billingStatus: processStatus(e.OverallOrdReltdBillgStatus),
      // A = approved, D = released by a credit representative; B / C = not or only partially approved.
      creditStatus: credit === 'B' || credit === 'C' ? 'BLOCKED' : credit === 'A' || credit === 'D' ? 'APPROVED' : 'NOT_CHECKED',
      ...(str(e.DeliveryBlockReason) && { deliveryBlock: str(e.DeliveryBlockReason) }),
      ...(str(e.HeaderBillingBlockReason) && { billingBlock: str(e.HeaderBillingBlockReason) }),
      items: results(e.to_Item).map((i) => ({
        item: str(i.SalesOrderItem),
        material: str(i.Material),
        description: str(i.SalesOrderItemText),
        quantity: num(i.RequestedQuantity),
        unit: str(i.RequestedQuantityUnit),
        netValue: { amount: num(i.NetAmount), currency: str(i.TransactionCurrency) || currency },
        ...(str(i.ProductionPlant) && { plant: str(i.ProductionPlant) }),
        ...(str(i.ShippingPoint) && { shippingPoint: str(i.ShippingPoint) }),
        ...(str(i.StorageLocation) && { storageLocation: str(i.StorageLocation) }),
        ...(str(i.ItemWeightUnit) && { grossWeight: num(i.ItemGrossWeight), netWeight: num(i.ItemNetWeight), weightUnit: str(i.ItemWeightUnit) }),
      })),
    };
  }

  private customerName(ctx: SapCallContext, id: string): Promise<string> {
    return id ? this.getCustomer(ctx, id).then((c) => c.name, () => id) : Promise.resolve('');
  }

  async getSalesOrder(ctx: SapCallContext, number: string): Promise<SalesOrder> {
    const e = (await this.request(ctx, `Sales order ${number}`, 'get', `${SERVICES.salesOrder}/A_SalesOrder(${lit(number)})`, { $expand: 'to_Item' })) as ODataEntity;
    return this.mapSalesOrder(e, await this.customerName(ctx, str(e.SoldToParty)));
  }

  async listOpenSalesOrders(ctx: SapCallContext, salesOrganization?: string): Promise<SalesOrder[]> {
    const res = await this.request(ctx, 'Open sales orders', 'get', `${SERVICES.salesOrder}/A_SalesOrder`, {
      $filter: `OverallSDProcessStatus ne 'C'${salesOrganization ? ` and SalesOrganization eq ${lit(salesOrganization)}` : ''}`,
      $orderby: 'CreationDate desc',
      $top: '50',
    });
    // Customer names are not resolved here: one lookup per order would multiply the SAP calls.
    return results(res).map((e) => this.mapSalesOrder(e, str(e.SoldToParty)));
  }

  async getSalesOrderFlow(ctx: SapCallContext, number: string): Promise<DocumentFlowStep[]> {
    const res = await this.request(ctx, `Document flow of sales order ${number}`, 'get', `${SERVICES.salesOrder}/A_SalesOrder(${lit(number)})/to_SubsequentProcFlowDoc`);
    return results(res).map((e) => ({
      category: FLOW_CATEGORY[str(e.SubsequentDocumentCategory)] ?? 'OTHER',
      document: str(e.SubsequentDocument),
      ...(str(e.SDProcessStatus) && { status: processStatus(e.SDProcessStatus).replaceAll('_', ' ').toLowerCase() }),
    }));
  }

  async getDelivery(ctx: SapCallContext, number: string): Promise<OutboundDelivery> {
    const e = (await this.request(ctx, `Outbound delivery ${number}`, 'get', `${SERVICES.delivery}/A_OutbDeliveryHeader(${lit(number)})`, {
      $expand: 'to_DeliveryDocumentItem',
    })) as ODataEntity;
    const items = results(e.to_DeliveryDocumentItem);
    const shipTo = str(e.ShipToParty);
    return {
      number: str(e.DeliveryDocument),
      shipTo,
      shipToName: await this.customerName(ctx, shipTo),
      ...(str(items[0]?.ReferenceSDDocument) && { salesOrder: str(items[0]?.ReferenceSDDocument) }),
      ...(str(e.ShippingPoint) && { shippingPoint: str(e.ShippingPoint) }),
      ...(odataDate(e.PlannedGoodsIssueDate) && { plannedGoodsIssueDate: odataDate(e.PlannedGoodsIssueDate) }),
      ...(odataDate(e.ActualGoodsMovementDate) && { actualGoodsIssueDate: odataDate(e.ActualGoodsMovementDate) }),
      goodsIssueStatus: processStatus(e.OverallGoodsMovementStatus),
      pickingStatus: processStatus(e.OverallPickingStatus),
      items: items.map((i) => ({
        item: str(i.DeliveryDocumentItem),
        material: str(i.Material),
        description: str(i.DeliveryDocumentItemText),
        quantity: num(i.ActualDeliveryQuantity),
        unit: str(i.DeliveryQuantityUnit),
        ...(str(i.Plant) && { plant: str(i.Plant) }),
        ...(str(i.StorageLocation) && { storageLocation: str(i.StorageLocation) }),
      })),
    };
  }

  async getBillingDocument(ctx: SapCallContext, number: string): Promise<BillingDocument> {
    const e = (await this.request(ctx, `Billing document ${number}`, 'get', `${SERVICES.billing}/A_BillingDocument(${lit(number)})`, { $expand: 'to_Item' })) as ODataEntity;
    const currency = str(e.TransactionCurrency);
    const items = results(e.to_Item);
    const payer = str(e.PayerParty) || str(e.SoldToParty);
    return {
      number: str(e.BillingDocument),
      billingType: str(e.BillingDocumentType),
      payer,
      payerName: await this.customerName(ctx, payer),
      billingDate: odataDate(e.BillingDocumentDate) ?? '',
      netValue: { amount: num(e.TotalNetAmount), currency },
      taxAmount: { amount: num(e.TotalTaxAmount), currency },
      companyCode: str(e.CompanyCode),
      ...(str(e.FiscalYear) && { fiscalYear: str(e.FiscalYear) }),
      ...(str(e.AccountingDocument) && { accountingDocument: str(e.AccountingDocument) }),
      postedToAccounting: e.AccountingPostingStatus === 'C',
      cancelled: e.BillingDocumentIsCancelled === true,
      ...(str(items[0]?.SalesDocument) && { salesOrder: str(items[0]?.SalesDocument) }),
      items: items.map((i) => ({
        item: str(i.BillingDocumentItem),
        material: str(i.Material),
        description: str(i.BillingDocumentItemText),
        quantity: num(i.BillingQuantity),
        unit: str(i.BillingQuantityUnit),
        netValue: { amount: num(i.NetAmount), currency: str(i.TransactionCurrency) || currency },
      })),
    };
  }

  async getCustomer(ctx: SapCallContext, id: string): Promise<Customer> {
    const e = (await this.request(ctx, `Customer ${id}`, 'get', `${SERVICES.bp}/A_Customer(${lit(id)})`)) as ODataEntity;
    return {
      id: str(e.Customer),
      name: str(e.CustomerName) || str(e.Customer),
      orderBlocked: !!str(e.OrderIsBlockedForCustomer),
      deliveryBlocked: !!str(e.DeliveryIsBlocked),
      billingBlocked: !!str(e.BillingIsBlockedForCustomer),
      postingBlocked: e.PostingIsBlocked === true,
    };
  }

  async getCreditProfile(ctx: SapCallContext, customer: string): Promise<CreditProfile> {
    const what = `Credit account of customer ${customer}`;
    const [accounts, partner, name, open] = await Promise.all([
      this.request(ctx, what, 'get', `${SERVICES.credit}/CreditManagementAccount`, { $filter: `BusinessPartner eq ${lit(customer)}`, $top: '1' }),
      this.request(ctx, what, 'get', `${SERVICES.credit}/CreditMgmtBusinessPartner(${lit(customer)})`).catch(() => ({})),
      this.customerName(ctx, customer),
      this.lineItems(ctx, `Open receivables of customer ${customer}`, `FinancialAccountType eq 'D' and Customer eq ${lit(customer)} and ClearingAccountingDocument eq ''`),
    ]);
    const account = results(accounts)[0];
    if (!account) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
    const currency = str(account.CreditSegmentCurrency) || str(open[0]?.CompanyCodeCurrency);
    return {
      customer,
      customerName: name,
      creditSegment: str(account.CreditSegment),
      limit: { amount: num(account.CreditLimitAmount), currency },
      // The released credit API does not return the exposure; open receivables are the closest readable figure.
      exposure: { amount: open.reduce((sum, i) => sum + num(i.AmountInCompanyCodeCurrency), 0), currency },
      exposureBasis: 'OPEN_RECEIVABLES',
      ...(str((partner as ODataEntity).CreditRiskClass) && { riskClass: str((partner as ODataEntity).CreditRiskClass) }),
      blocked: account.CreditAccountIsBlocked === true,
    };
  }

  private async lineItems(ctx: SapCallContext, what: string, filter: string): Promise<ODataEntity[]> {
    return results(await this.request(ctx, what, 'get', `${SERVICES.lineItems}/A_OperationalAcctgDocItemCube`, { $select: LINE_ITEM_FIELDS, $filter: filter, $top: '200' }));
  }

  async listOpenItems(ctx: SapCallContext, query: OpenItemQuery): Promise<OpenItem[]> {
    const type = ACCOUNT_TYPE[query.accountType];
    if (query.accountType === 'GL' && !query.account) throw new SapError('INVALID_INPUT', 'A G/L account is required to list G/L line items.');
    if (query.dueBy && !/^\d{4}-\d{2}-\d{2}$/.test(query.dueBy)) throw new SapError('INVALID_INPUT', 'The due date must have the format YYYY-MM-DD.');
    const filter = [
      `CompanyCode eq ${lit(query.companyCode)}`,
      `FinancialAccountType eq '${type.code}'`,
      ...(query.account ? [`${type.field} eq ${lit(query.account)}`] : []),
      ...(query.status === 'OPEN' ? [`ClearingAccountingDocument eq ''`] : query.status === 'CLEARED' ? [`ClearingAccountingDocument ne ''`] : []),
      ...(query.dueBy ? [`NetDueDate le datetime'${query.dueBy}T00:00:00'`] : []),
    ].join(' and ');
    const rows = await this.lineItems(ctx, `${query.accountType.toLowerCase()} line items in company code ${query.companyCode}`, filter);
    return rows.map((e) => ({
      companyCode: str(e.CompanyCode),
      fiscalYear: str(e.FiscalYear),
      document: str(e.AccountingDocument),
      item: str(e.AccountingDocumentItem),
      documentType: str(e.AccountingDocumentType),
      accountType: query.accountType,
      account: str(e[type.field]),
      postingDate: odataDate(e.PostingDate) ?? '',
      ...(odataDate(e.NetDueDate) && { dueDate: odataDate(e.NetDueDate) }),
      amount: { amount: num(e.AmountInCompanyCodeCurrency), currency: str(e.CompanyCodeCurrency) },
      ...(str(e.ClearingAccountingDocument) && { clearingDocument: str(e.ClearingAccountingDocument) }),
      ...(odataDate(e.ClearingDate) && { clearingDate: odataDate(e.ClearingDate) }),
      ...(str(e.AssignmentReference) && { assignment: str(e.AssignmentReference) }),
      ...(str(e.DocumentItemText) && { text: str(e.DocumentItemText) }),
      ...(str(e.PaymentBlockingReason) && { paymentBlock: str(e.PaymentBlockingReason) }),
    }));
  }

  async getAccountingDocument(ctx: SapCallContext, companyCode: string, fiscalYear: string, number: string): Promise<AccountingDocument> {
    const what = `Accounting document ${number}`;
    // 0L is the standard leading ledger; without it every parallel ledger would repeat the items.
    const rows = results(
      await this.request(ctx, what, 'get', `${SERVICES.journal}/A_JournalEntryItemBasic`, {
        $filter: `CompanyCode eq ${lit(companyCode)} and FiscalYear eq ${lit(fiscalYear)} and AccountingDocument eq ${lit(number)} and Ledger eq '0L'`,
        $top: '200',
      }),
    );
    const head = rows[0];
    if (!head) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
    return {
      companyCode,
      fiscalYear,
      number,
      documentType: str(head.AccountingDocumentType),
      postingDate: odataDate(head.PostingDate) ?? '',
      ...(odataDate(head.DocumentDate) && { documentDate: odataDate(head.DocumentDate) }),
      ...(str(head.DocumentReferenceID) && { reference: str(head.DocumentReferenceID) }),
      items: rows.map((e) => ({
        item: str(e.LedgerGLLineItem),
        account: str(e.Customer) || str(e.Supplier) || str(e.GLAccount),
        ...(str(e.DocumentItemText) && { description: str(e.DocumentItemText) }),
        amount: { amount: num(e.AmountInCompanyCodeCurrency), currency: str(e.CompanyCodeCurrency) },
        debitCredit: e.DebitCreditCode === 'H' ? ('C' as const) : ('D' as const),
        ...(str(e.ProfitCenter) && { profitCenter: str(e.ProfitCenter) }),
        ...(str(e.CostCenter) && { costCenter: str(e.CostCenter) }),
      })),
    };
  }

  async getMaterialStock(ctx: SapCallContext, material: string, plant?: string): Promise<MaterialStock[]> {
    const rows = results(
      await this.request(ctx, `Stock of material ${material}`, 'get', `${SERVICES.stock}/A_MatlStkInAcctMod`, {
        $filter: `Material eq ${lit(material)}${plant ? ` and Plant eq ${lit(plant)}` : ''}`,
        $top: '500',
      }),
    );
    if (!rows.length) throw new SapError('NOT_FOUND', `No stock was found in SAP for material ${material}${plant ? ` in plant ${plant}` : ''}.`);
    const byLocation = new Map<string, MaterialStock>();
    for (const e of rows) {
      const key = `${str(e.Plant)}/${str(e.StorageLocation)}`;
      const stock = byLocation.get(key) ?? {
        material,
        plant: str(e.Plant),
        ...(str(e.StorageLocation) && { storageLocation: str(e.StorageLocation) }),
        unrestricted: 0,
        qualityInspection: 0,
        blocked: 0,
        unit: str(e.MaterialBaseUnit),
      };
      const quantity = num(e.MatlWrhsStkQtyInMatlBaseUnit);
      // Inventory stock types: 01 unrestricted-use, 02 quality inspection, 07 blocked.
      if (e.InventoryStockType === '01') stock.unrestricted += quantity;
      else if (e.InventoryStockType === '02') stock.qualityInspection += quantity;
      else if (e.InventoryStockType === '07') stock.blocked += quantity;
      byLocation.set(key, stock);
    }
    return [...byLocation.values()];
  }

  async getInfoRecords(ctx: SapCallContext, material: string, supplier?: string): Promise<InfoRecord[]> {
    const rows = results(
      await this.request(ctx, `Purchasing info records of material ${material}`, 'get', `${SERVICES.infoRecord}/A_PurchasingInfoRecord`, {
        $filter: `Material eq ${lit(material)}${supplier ? ` and Supplier eq ${lit(supplier)}` : ''}`,
        $expand: 'to_PurgInfoRecdOrgPlantData',
        $top: '20',
      }),
    );
    return rows.flatMap((e) =>
      results(e.to_PurgInfoRecdOrgPlantData).map((o) => ({
        infoRecord: str(e.PurchasingInfoRecord),
        supplier: str(e.Supplier),
        material: str(e.Material),
        ...(str(o.PurchasingOrganization) && { purchasingOrganization: str(o.PurchasingOrganization) }),
        ...(str(o.Plant) && { plant: str(o.Plant) }),
        netPrice: { amount: num(o.NetPriceAmount), currency: str(o.Currency) },
        ...(o.MaterialPlannedDeliveryDurn != null && { plannedDeliveryDays: num(o.MaterialPlannedDeliveryDurn) }),
        ...(str(o.LastReferencingPurchaseOrder) && { lastPurchaseOrder: str(o.LastReferencingPurchaseOrder) }),
      })),
    );
  }

  async listBlockedInvoices(ctx: SapCallContext, companyCode: string): Promise<Invoice[]> {
    const rows = results(
      await this.request(ctx, `Blocked invoices in company code ${companyCode}`, 'get', `${SERVICES.invoice}/A_SupplierInvoice`, {
        $filter: `CompanyCode eq ${lit(companyCode)} and PaymentBlockingReason ne ''`,
        $orderby: 'PostingDate desc',
        $top: '50',
      }),
    );
    // Supplier names are not resolved here: one lookup per invoice would multiply the SAP calls.
    return rows.map((e) => {
      const block = str(e.PaymentBlockingReason);
      return {
        number: str(e.SupplierInvoice),
        fiscalYear: str(e.FiscalYear),
        companyCode: str(e.CompanyCode),
        vendorId: str(e.InvoicingParty),
        vendorName: str(e.InvoicingParty),
        gross: { amount: num(e.InvoiceGrossAmount), currency: str(e.DocumentCurrency) },
        ...(odataDate(e.PostingDate) && { postingDate: odataDate(e.PostingDate) }),
        ...(odataDate(e.DueCalculationBaseDate) && { dueDate: odataDate(e.DueCalculationBaseDate) }),
        status: 'PAYMENT_BLOCKED' as const,
        paymentBlock: { code: block, description: block === 'R' ? 'Invoice verification' : `Payment block ${block}` },
      };
    });
  }

  async getInvoicesForPurchaseOrder(ctx: SapCallContext, purchaseOrder: string): Promise<Invoice[]> {
    const refs = results(
      await this.request(ctx, `Invoices for purchase order ${purchaseOrder}`, 'get', `${SERVICES.invoice}/A_SuplrInvcItemPurOrdRef`, {
        $filter: `PurchaseOrder eq ${lit(purchaseOrder)}`,
        $select: 'SupplierInvoice,FiscalYear',
        $top: '100',
      }),
    );
    const keys = [...new Set(refs.map((r) => `${str(r.SupplierInvoice)}/${str(r.FiscalYear)}`))].slice(0, 20);
    const invoices = await Promise.all(keys.map((key) => this.getInvoice(ctx, key.split('/')[0]!, key.split('/')[1])));
    return invoices.filter((i) => i.status !== 'REVERSED');
  }

  async createPurchaseRequisition(ctx: SapCallContext, requisition: NewPurchaseRequisition): Promise<PurchaseRequisition> {
    const created = (await this.request(ctx, `Purchase requisition for material ${requisition.material}`, 'post', `${SERVICES.pr}/A_PurchaseRequisitionHeader`, undefined, {
      body: {
        PurchaseRequisitionType: 'NB',
        to_PurchaseReqnItem: {
          results: [
            {
              Material: requisition.material,
              Plant: requisition.plant,
              RequestedQuantity: String(requisition.quantity),
              ...(requisition.deliveryDate && { DeliveryDate: toODataDate(requisition.deliveryDate) }),
            },
          ],
        },
      },
    })) as ODataEntity;
    return this.getPurchaseRequisition(ctx, str(created.PurchaseRequisition));
  }

  async createPurchaseOrder(ctx: SapCallContext, order: NewPurchaseOrder): Promise<PurchaseOrder> {
    const created = (await this.request(ctx, `Purchase order for supplier ${order.supplier}`, 'post', `${SERVICES.po}/A_PurchaseOrder`, undefined, {
      body: {
        PurchaseOrderType: 'NB',
        CompanyCode: order.companyCode,
        PurchasingOrganization: order.purchasingOrganization,
        PurchasingGroup: order.purchasingGroup,
        Supplier: order.supplier,
        to_PurchaseOrderItem: {
          results: [
            {
              Material: order.material,
              Plant: order.plant,
              OrderQuantity: String(order.quantity),
              // Without a price SAP takes it from the purchasing info record.
              ...(order.netPrice !== undefined && { NetPriceAmount: String(order.netPrice) }),
            },
          ],
        },
      },
    })) as ODataEntity;
    return this.getPurchaseOrder(ctx, str(created.PurchaseOrder));
  }

  async postGoodsReceipt(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]> {
    const [po, received] = await Promise.all([this.getPurchaseOrder(ctx, purchaseOrder), this.getGoodsReceipts(ctx, purchaseOrder)]);
    const open = po.items
      .map((i) => ({ ...i, open: i.quantity - received.filter((g) => g.item === i.item).reduce((sum, g) => sum + g.quantity, 0) }))
      .filter((i) => i.open > 0);
    if (!open.length) throw new SapError('BUSINESS_RULE', `Purchase order ${purchaseOrder} is already completely received.`);

    const today = toODataDate(todayIso());
    const created = (await this.request(ctx, `Goods receipt for purchase order ${purchaseOrder}`, 'post', `${SERVICES.gr}/A_MaterialDocumentHeader`, undefined, {
      body: {
        GoodsMovementCode: '01', // goods receipt for purchase order (MIGO A01 / R01)
        PostingDate: today,
        DocumentDate: today,
        to_MaterialDocumentItem: {
          results: open.map((i) => ({
            Material: i.material,
            GoodsMovementType: '101',
            GoodsMovementRefDocType: 'B',
            PurchaseOrder: purchaseOrder,
            PurchaseOrderItem: i.item,
            QuantityInEntryUnit: String(i.open),
            EntryUnit: i.unit,
          })),
        },
      },
    })) as ODataEntity;
    const document = str(created.MaterialDocument);
    return (await this.getGoodsReceipts(ctx, purchaseOrder)).filter((g) => g.materialDocument === document);
  }

  async createSupplierInvoice(ctx: SapCallContext, invoice: NewSupplierInvoice): Promise<Invoice> {
    const [po, received] = await Promise.all([this.getPurchaseOrder(ctx, invoice.purchaseOrder), this.getGoodsReceipts(ctx, invoice.purchaseOrder)]);
    const currency = po.value.currency;
    const date = toODataDate(invoice.invoiceDate ?? todayIso());
    // Each order item is invoiced for the quantity received so far, at the order price.
    const items = po.items
      .map((i) => ({ ...i, received: received.filter((g) => g.item === i.item).reduce((sum, g) => sum + g.quantity, 0) }))
      .filter((i) => i.received > 0);
    if (!items.length) throw new SapError('BUSINESS_RULE', `No goods receipt has been posted for purchase order ${invoice.purchaseOrder}, so there is nothing to invoice.`);

    const created = (await this.request(ctx, `Supplier invoice for purchase order ${invoice.purchaseOrder}`, 'post', `${SERVICES.invoice}/A_SupplierInvoice`, undefined, {
      body: {
        CompanyCode: po.companyCode,
        DocumentDate: date,
        PostingDate: toODataDate(todayIso()),
        InvoicingParty: po.vendorId,
        DocumentCurrency: currency,
        InvoiceGrossAmount: String(invoice.grossAmount),
        SupplierInvoiceIDByInvcgParty: invoice.reference,
        TaxIsCalculatedAutomatically: true,
        to_SuplrInvcItemPurOrdRef: {
          results: items.map((i, index) => ({
            SupplierInvoiceItem: String(index + 1),
            PurchaseOrder: invoice.purchaseOrder,
            PurchaseOrderItem: i.item,
            DocumentCurrency: currency,
            SupplierInvoiceItemAmount: String(i.netPrice.amount * i.received),
            PurchaseOrderQuantityUnit: i.unit,
            QuantityInPurchaseOrderUnit: String(i.received),
            ...(invoice.taxCode && { TaxCode: invoice.taxCode }),
          })),
        },
      },
    })) as ODataEntity;
    return this.getInvoice(ctx, str(created.SupplierInvoice), str(created.FiscalYear) || undefined);
  }

  async createDelivery(ctx: SapCallContext, salesOrder: string): Promise<OutboundDelivery> {
    const order = await this.getSalesOrder(ctx, salesOrder);
    const created = (await this.request(ctx, `Outbound delivery for sales order ${salesOrder}`, 'post', `${SERVICES.delivery}/A_OutbDeliveryHeader`, undefined, {
      body: { to_DeliveryDocumentItem: { results: order.items.map((i) => ({ ReferenceSDDocument: order.number, ReferenceSDDocumentItem: i.item })) } },
    })) as ODataEntity;
    return this.getDelivery(ctx, str(created.DeliveryDocument));
  }

  async postGoodsIssue(ctx: SapCallContext, delivery: string): Promise<OutboundDelivery> {
    // The API requires an ETag; '*' posts against the current version of the delivery.
    await this.request(ctx, `Goods issue for delivery ${delivery}`, 'post', `${SERVICES.delivery}/PostGoodsIssue`, { DeliveryDocument: lit(delivery) }, { headers: { 'if-match': '*' } });
    return this.getDelivery(ctx, delivery);
  }

  async createBillingDocument(ctx: SapCallContext, delivery: string): Promise<BillingDocument> {
    const what = `Billing document for delivery ${delivery}`;
    // Static action of API_BILLINGDOCUMENT (OData V4). Posting to accounting stays enabled, so the
    // invoice is released to FI in the same step, as in VF01.
    const res = (await this.requestV4(ctx, what, 'post', `${SERVICES.billingV4}/BillingDocument/SAP__self.CreateFromSDDocument`, {
      body: { _Reference: [{ SDDocument: delivery }], _Control: { AutomPostingToAcctgIsDisabled: false } },
    })) as { value?: ODataEntity[] } & ODataEntity;
    const created = str((res.value?.[0] ?? res).BillingDocument);
    if (!created) throw new SapError('BUSINESS_RULE', `SAP did not create a billing document for delivery ${delivery}.`);
    return this.getBillingDocument(ctx, created);
  }

  /* ---------------- finance analysis ---------------- */

  async searchGLAccounts(ctx: SapCallContext, searchText: string, companyCode?: string): Promise<GLAccountInfo[]> {
    const rows = results(
      await this.request(ctx, `G/L accounts matching "${searchText}"`, 'get', `${SERVICES.glPost}/FAC_POST_JOUR_ENTRY_GLACCT_VH`, {
        $select: 'GLAccountExternal,GLAccount_Text,GLAccountLongName,CompanyCode,ChartOfAccounts',
        // The value help matches the short text case-sensitively; account texts are upper case.
        $filter: [...(companyCode ? [`CompanyCode eq ${lit(companyCode)}`] : []), `substringof(${lit(searchText.toUpperCase())},GLAccount_Text)`].join(' and '),
        $top: '50',
      }),
    );
    const seen = new Set<string>();
    return rows
      .filter((r) => str(r.GLAccountExternal) && !seen.has(`${str(r.GLAccountExternal)}|${str(r.ChartOfAccounts)}`) && seen.add(`${str(r.GLAccountExternal)}|${str(r.ChartOfAccounts)}`))
      .map((r) => ({
        account: str(r.GLAccountExternal),
        name: str(r.GLAccount_Text),
        ...(str(r.GLAccountLongName) && { longName: str(r.GLAccountLongName) }),
        ...(str(r.CompanyCode) && { companyCode: str(r.CompanyCode) }),
        ...(str(r.ChartOfAccounts) && { chartOfAccounts: str(r.ChartOfAccounts) }),
      }));
  }

  async getAccountActivity(ctx: SapCallContext, companyCode: string, fiscalYear: string, periodFrom?: string, periodTo?: string): Promise<AccountActivity[]> {
    const rows = results(
      await this.request(ctx, `G/L activity of company code ${companyCode}`, 'get', `${SERVICES.glBalance}/GL_ACCOUNT_BALANCESet`, {
        $select: 'GLAccount,GLAccountName,LedgerFiscalPeriod,DebitAmountInCompanyCodeCrcy,CreditAmountInCoCodeCrcy,CompanyCodeCurrency',
        $filter: `Ledger eq '0L' and CompanyCode eq ${lit(companyCode)} and LedgerFiscalYear eq ${lit(fiscalYear)}`,
        $top: '2000',
      }),
    );
    // The service rejects period ranges in $filter, so the range and the 000 / 999 rows are filtered here.
    const from = Math.max(Number(periodFrom ?? '1'), 1);
    const to = Math.min(Number(periodTo ?? '16'), 16);
    const byAccount = new Map<string, AccountActivity>();
    for (const r of rows) {
      const period = Number(str(r.LedgerFiscalPeriod));
      const account = str(r.GLAccount);
      if (!account || !(period >= from && period <= to)) continue;
      const entry = byAccount.get(account) ?? { account, name: str(r.GLAccountName), debit: 0, credit: 0, net: 0, currency: str(r.CompanyCodeCurrency) };
      entry.debit += Math.abs(num(r.DebitAmountInCompanyCodeCrcy));
      entry.credit += Math.abs(num(r.CreditAmountInCoCodeCrcy));
      entry.name ||= str(r.GLAccountName);
      byAccount.set(account, entry);
    }
    return [...byAccount.values()]
      .map((e) => ({ ...e, debit: round2(e.debit), credit: round2(e.credit), net: round2(e.debit - e.credit) }))
      .sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
  }

  async getReceivablesAging(ctx: SapCallContext, companyCode: string, currency: string): Promise<ReceivablesAging[]> {
    if (!/^[A-Z]{3}$/.test(currency)) throw new SapError('INVALID_INPUT', 'The currency must be a three-letter code.');
    const entity = `C_ARAGINGANALYSISOVW(P_DisplayCurrency='${currency}',P_NetDueInterval1InDays='30',P_NetDueInterval2InDays='60',P_NetDueInterval3InDays='90')/Results`;
    const rows = results(
      await this.request(ctx, `Receivables aging of company code ${companyCode}`, 'get', `${SERVICES.arAging}/${entity}`, {
        $select: 'Customer,CompanyCode,TotalAmountInDisplayCrcy,NetDueIntvl2AmtInDspCrcy,NetDueIntvl3AmtInDspCrcy,NetDueIntvl4AmtInDspCrcy,DisplayCurrency',
        $filter: `CompanyCode eq ${lit(companyCode)}`,
        $top: '500',
      }),
    );
    const byCustomer = new Map<string, ReceivablesAging>();
    for (const r of rows) {
      const customer = str(r.Customer);
      if (!customer) continue;
      const entry = byCustomer.get(customer) ?? { customer, total: 0, upTo30: 0, days31to60: 0, days61to90: 0, over90: 0, currency: str(r.DisplayCurrency) || currency };
      entry.total += num(r.TotalAmountInDisplayCrcy);
      entry.days31to60 += num(r.NetDueIntvl2AmtInDspCrcy);
      entry.days61to90 += num(r.NetDueIntvl3AmtInDspCrcy);
      entry.over90 += num(r.NetDueIntvl4AmtInDspCrcy);
      byCustomer.set(customer, entry);
    }
    return [...byCustomer.values()]
      .map((e) => ({ ...e, total: round2(e.total), days31to60: round2(e.days31to60), days61to90: round2(e.days61to90), over90: round2(e.over90), upTo30: round2(e.total - e.days31to60 - e.days61to90 - e.over90) }))
      .sort((x, y) => y.total - x.total);
  }

  async getPayablesAging(ctx: SapCallContext, companyCode: string, keyDate = todayIso()): Promise<PayablesAging> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(keyDate)) throw new SapError('INVALID_INPUT', 'The key date must have the format YYYY-MM-DD.');
    const limit = 2000;
    const rows = results(
      await this.request(ctx, `Open supplier items of company code ${companyCode}`, 'get', `${SERVICES.supplierItems}/Items`, {
        $select: 'Supplier,SupplierName,DebitCreditCode,AmountInCompanyCodeCurrency,CompanyCodeCurrency,NetDueDate',
        // Clearing status 2 = open.
        $filter: `CompanyCode eq ${lit(companyCode)} and ClearingStatus eq '2'`,
        $top: String(limit),
      }),
    );
    const buckets = AGING_BUCKETS.map((bucket) => ({ bucket, amount: 0, items: 0 }));
    const suppliers = new Map<string, PayablesAging['suppliers'][number]>();
    for (const r of rows) {
      // Payables are credits; they are reported as positive amounts and debit memos as negative.
      const raw = Math.abs(num(r.AmountInCompanyCodeCurrency));
      const amount = str(r.DebitCreditCode) === 'S' ? -raw : raw;
      const due = odataDate(r.NetDueDate);
      const overdueDays = due ? daysBetween(due, keyDate) : 0;
      const bucket = buckets[overdueDays <= 0 ? 0 : overdueDays <= 30 ? 1 : overdueDays <= 60 ? 2 : overdueDays <= 90 ? 3 : 4]!;
      bucket.amount += amount;
      bucket.items += 1;
      const supplier = suppliers.get(str(r.Supplier)) ?? { supplier: str(r.Supplier), ...(str(r.SupplierName) && { name: str(r.SupplierName) }), amount: 0, overdue: 0, items: 0 };
      supplier.amount += amount;
      if (overdueDays > 0) supplier.overdue += amount;
      supplier.items += 1;
      suppliers.set(supplier.supplier, supplier);
    }
    return {
      companyCode,
      keyDate,
      currency: str(rows[0]?.CompanyCodeCurrency),
      buckets: buckets.map((b) => ({ ...b, amount: round2(b.amount) })),
      suppliers: [...suppliers.values()].map((x) => ({ ...x, amount: round2(x.amount), overdue: round2(x.overdue) })).sort((x, y) => y.amount - x.amount),
      truncated: rows.length >= limit,
    };
  }

  async listInvoiceApprovals(ctx: SapCallContext, companyCode: string): Promise<InvoiceApproval[]> {
    const rows = results(
      await this.request(ctx, `Supplier invoices of company code ${companyCode}`, 'get', `${SERVICES.invoiceList}/C_SupplierInvoiceList`, {
        $select: 'SupplierInvoice,FiscalYear,InvoicingParty,InvoicingPartyName,PostingDate,InvoiceGrossAmount,DocumentCurrency,InvoiceStatusAndOrigin_Text,IsBlocked,ApprovalStatusName,ApproverName',
        $filter: `CompanyCode eq ${lit(companyCode)}`,
        $top: '100',
      }),
    );
    return rows.map((r) => ({
      invoice: str(r.SupplierInvoice),
      fiscalYear: str(r.FiscalYear),
      supplier: str(r.InvoicingParty),
      supplierName: str(r.InvoicingPartyName) || str(r.InvoicingParty),
      gross: { amount: num(r.InvoiceGrossAmount), currency: str(r.DocumentCurrency) },
      ...(odataDate(r.PostingDate) && { postingDate: odataDate(r.PostingDate) }),
      status: str(r.InvoiceStatusAndOrigin_Text),
      blocked: isTrue(r.IsBlocked),
      ...(str(r.ApprovalStatusName) && { approvalStatus: str(r.ApprovalStatusName) }),
      ...(str(r.ApproverName) && { approver: str(r.ApproverName) }),
    }));
  }

  async getPaymentRunProposal(ctx: SapCallContext, companyCode: string, runId?: string): Promise<PaymentRunProposal> {
    const what = `Payment run proposal of company code ${companyCode}`;
    const run = runId ? ` and PaymentRunId eq ${lit(runId)}` : '';
    const read = (entity: string, companyField: string, top: string) =>
      this.request(ctx, what, 'get', `${SERVICES.paymentProposal}/${entity}`, { $filter: `${companyField} eq ${lit(companyCode)}${run}`, $top: top }).then(results);
    const [runs, items, exceptions] = await Promise.all([read('PaymentSummarySet', 'PayingCompanyCode', '100'), read('PaymentItemSet', 'CompanyCode', '500'), read('ExceptionSet', 'CompanyCode', '200')]);
    const money = (r: ODataEntity, ...fields: string[]) => ({ amount: Math.abs(num(fields.map((f) => r[f]).find((v) => num(v) !== 0))), currency: str(r.Currency) || str(r.PaymentCurrency) });
    return {
      runs: runs.map((r) => ({
        runId: str(r.PaymentRunId),
        ...(odataDate(r.PaymentRunDate) && { runDate: odataDate(r.PaymentRunDate) }),
        isProposal: isTrue(r.PaymentRunIsProposal),
        ...(str(r.PaymentMethodName) || str(r.PaymentMethod) ? { paymentMethod: str(r.PaymentMethodName) || str(r.PaymentMethod) } : {}),
        amount: money(r, 'AmountInCompanyCodeCurrency', 'PaidAmountInPaytCurrency'),
      })),
      items: items.map((r) => ({
        runId: str(r.PaymentRunId),
        supplier: str(r.Supplier),
        ...(str(r.SupplierName) && { supplierName: str(r.SupplierName) }),
        document: str(r.AccountingDocument),
        ...(str(r.PaymentMethod) && { paymentMethod: str(r.PaymentMethod) }),
        amount: money(r, 'NetAmountInCoCodeCurrency', 'AmountInTransactionCurrency'),
      })),
      exceptions: exceptions.map((r) => ({
        runId: str(r.PaymentRunId),
        supplier: str(r.Supplier),
        ...(str(r.SupplierName) && { supplierName: str(r.SupplierName) }),
        document: str(r.AccountingDocument),
        ...(str(r.PaymentBlockingReason) && { blockingReason: str(r.PaymentBlockingReason) }),
        message: str(r.SystemMessageDescription),
        amount: money(r, 'AmountInTransactionCurrency'),
      })),
    };
  }

  async listGRIRCases(ctx: SapCallContext, companyCode: string, fiscalYear?: string): Promise<GRIRCase[]> {
    const rows = results(
      await this.request(ctx, `GR/IR cases of company code ${companyCode}`, 'get', `${SERVICES.grir}/C_GRIRProcessDigest`, {
        $select:
          'PurchasingDocument,PurchasingDocumentItem,Supplier,SupplierName,GRIRClearingProcessStatus_Text,GRIRClearingProcessPriority_Text,GRIRClearingProcessRootCause_Text,DueDays,NumberOfOpenItems,AmountInCompanyCodeCurrency,CompanyCodeCurrency',
        $filter: `CompanyCode eq ${lit(companyCode)}${fiscalYear ? ` and FiscalYear eq ${lit(fiscalYear)}` : ''}`,
        $top: '200',
      }),
    );
    return rows.map((r) => ({
      purchaseOrder: str(r.PurchasingDocument),
      item: str(r.PurchasingDocumentItem),
      supplier: str(r.Supplier),
      ...(str(r.SupplierName) && { supplierName: str(r.SupplierName) }),
      ...(str(r.GRIRClearingProcessStatus_Text) && { status: str(r.GRIRClearingProcessStatus_Text) }),
      ...(str(r.GRIRClearingProcessPriority_Text) && { priority: str(r.GRIRClearingProcessPriority_Text) }),
      ...(str(r.GRIRClearingProcessRootCause_Text) && { rootCause: str(r.GRIRClearingProcessRootCause_Text) }),
      ...(str(r.DueDays) && { dueDays: num(r.DueDays) }),
      openItems: num(r.NumberOfOpenItems),
      balance: { amount: num(r.AmountInCompanyCodeCurrency), currency: str(r.CompanyCodeCurrency) },
    }));
  }

  async listCreditBlockedOrders(ctx: SapCallContext, customer?: string): Promise<SalesOrder[]> {
    const res = await this.request(ctx, 'Credit-blocked sales orders', 'get', `${SERVICES.salesOrder}/A_SalesOrder`, {
      // Credit status B = the credit check was not passed.
      $filter: `TotalCreditCheckStatus eq 'B'${customer ? ` and SoldToParty eq ${lit(customer)}` : ''}`,
      $top: '100',
    });
    return results(res).map((e) => this.mapSalesOrder(e, str(e.SoldToParty)));
  }

  async getBankReconciliation(ctx: SapCallContext, companyCode: string): Promise<BankReconciliationAccount[]> {
    const rows = results(
      await this.request(ctx, `Bank reconciliation of company code ${companyCode}`, 'get', `${SERVICES.bankReconciliation}/GLAccountHouseBankAccountWorklistItems`, {
        $select: 'CompanyCode,GLAccount,GLAccountName,HouseBank,HouseBankAccount,NumberOfOpenItems,BalanceAmountInCompanyCodeCrcy,CompanyCodeCurrency',
        $filter: `CompanyCode eq ${lit(companyCode)}`,
        $top: '200',
      }),
    );
    return rows.map((r) => ({
      companyCode: str(r.CompanyCode),
      glAccount: str(r.GLAccount),
      ...(str(r.GLAccountName) && { glAccountName: str(r.GLAccountName) }),
      houseBank: str(r.HouseBank),
      houseBankAccount: str(r.HouseBankAccount),
      openItems: Math.trunc(num(r.NumberOfOpenItems)),
      openBalance: { amount: num(r.BalanceAmountInCompanyCodeCrcy), currency: str(r.CompanyCodeCurrency) },
    }));
  }

  async getDepreciationOverview(ctx: SapCallContext, companyCode: string, fiscalYear: string): Promise<DepreciationOverview> {
    const what = `Fixed assets of company code ${companyCode}`;
    const master = results(
      await this.request(ctx, what, 'get', `${SERVICES.assets}/C_FixedAssetMaintain`, {
        $select: 'MasterFixedAsset,FixedAsset,FixedAssetDescription',
        $filter: `CompanyCode eq ${lit(companyCode)}`,
        $top: '100',
      }),
    );
    // The value views are parameterized per asset; a blank asset returns nothing, so each asset is read on its own.
    const params = (r: ODataEntity) =>
      `(P_MasterFixedAsset=${lit(str(r.MasterFixedAsset))},P_FixedAsset=${lit(str(r.FixedAsset) || '0')},P_CompanyCode=${lit(companyCode)},P_AssetDepreciationArea='01',P_CurrencyRole='10',` +
      `P_CreationDateTime=datetimeoffset'${todayIso()}T00:00:00Z',P_FirstFiscalYear=${lit(fiscalYear)})/Results`;
    const overview: DepreciationOverview = { companyCode, fiscalYear, assets: [], exceptions: [], truncated: master.length > MAX_ASSETS };
    for (const asset of master.slice(0, MAX_ASSETS)) {
      const [periods, balances] = await Promise.all([
        this.request(ctx, what, 'get', `${SERVICES.assetValues}/C_FxdAstDeprValueByCrcyRole${params(asset)}`, { $top: '100' }).then(results),
        this.request(ctx, what, 'get', `${SERVICES.assetValues}/C_Fixedassetnetbookvalue${params(asset)}`, { $top: '100' }).then(results),
      ]);
      if (!periods.length && !balances.length) continue;
      const id = str(asset.MasterFixedAsset);
      let posted = 0;
      let unposted = 0;
      for (const p of periods) {
        // Depreciation is posted as a credit; it is reported as a positive expense.
        const amount = Math.abs(num(p.OrdinaryDeprAmtInDspCrcy)) + Math.abs(num(p.SpecialDeprAmtInDspCrcy)) + Math.abs(num(p.UnplannedDeprAmtInDspCrcy));
        const status = str(p.DepreciationStatus).toUpperCase();
        if (DEPRECIATION_POSTED.has(status)) posted += amount;
        else {
          unposted += amount;
          if (amount) overview.exceptions.push({ asset: id, period: str(p.FiscalPeriod), status: status === '1' ? 'Planned, not yet posted' : `Status ${status || 'unknown'}`, amount: round2(amount), currency: str(p.Currency) });
        }
      }
      overview.assets.push({
        asset: id,
        description: str(asset.FixedAssetDescription),
        posted: round2(posted),
        unposted: round2(unposted),
        netBookValue: round2(balances.reduce((sum, b) => sum + num(b.EndingBalAmtInDspCrcy), 0)),
        currency: str(periods[0]?.Currency) || str(balances[0]?.Currency),
      });
    }
    return overview;
  }

  /* ---------------- clearing and journal entry: posting service of the Post General Journal Entries app ---------------- */

  /** Posts a temporary document of the posting service and returns the accounting document SAP created. */
  private async postTemporaryDocument(ctx: SapCallContext, what: string, companyCode: string, draft: ODataEntity): Promise<PostedDocument> {
    const res = (await this.request(ctx, what, 'post', `${SERVICES.glPost}/Post`, { TmpIdType: lit(str(draft.TmpIdType)), TmpId: lit(str(draft.TmpId)) })) as ODataEntity;
    const key = (res.Post ?? res) as ODataEntity;
    if (!str(key.AccountingDocument)) throw new SapError('BUSINESS_RULE', `SAP did not post ${what.charAt(0).toLowerCase()}${what.slice(1)}. Check the document in SAP for the reason.`);
    return { document: str(key.AccountingDocument), ...(str(key.FiscalYear) && { fiscalYear: str(key.FiscalYear) }), companyCode: str(key.CompanyCode) || companyCode };
  }

  async clearOpenItems(ctx: SapCallContext, request: ClearingRequest): Promise<PostedDocument> {
    const what = `Clearing of ${request.accountType.toLowerCase()} ${request.account}`;
    const anchor = (await this.listOpenItems(ctx, { accountType: request.accountType, account: request.account, companyCode: request.companyCode, status: 'OPEN' }))[0];
    if (!anchor) throw new SapError('BUSINESS_RULE', `${request.accountType === 'CUSTOMER' ? 'Customer' : 'Supplier'} ${request.account} has no open items in company code ${request.companyCode}.`);
    const type = ACCOUNT_TYPE[request.accountType].code;
    // The protocol of the app: start a clearing from one open item, select the account's open items, post.
    const created = (await this.request(ctx, what, 'post', `${SERVICES.glPost}/CreateClearingForOpenItem`, {
      AccountingDocument: lit(anchor.document),
      CompanyCode: lit(request.companyCode),
      FiscalYear: lit(anchor.fiscalYear),
      AccountingDocumentItem: lit(anchor.item),
      Account: lit(request.account),
      FinancialAccountType: lit(type),
      ClearingTransaction: "'UMBUCHNG'",
    })) as ODataEntity;
    const draft = (created.CreateClearingForOpenItem ?? created) as ODataEntity;
    if (!str(draft.TmpId)) throw new SapError('BUSINESS_RULE', `SAP did not start a clearing for ${request.accountType.toLowerCase()} ${request.account}.`);
    await this.request(ctx, what, 'post', `${SERVICES.glPost}/ActivateItemsToBeCleared`, {
      TmpId: lit(str(draft.TmpId)),
      TmpIdType: lit(str(draft.TmpIdType)),
      Account: lit(request.account),
      CompanyCode: lit(request.companyCode),
      FinancialAccountType: lit(type),
    });
    return this.postTemporaryDocument(ctx, what, request.companyCode, draft);
  }

  async postJournalEntry(ctx: SapCallContext, entry: NewJournalEntry): Promise<PostedDocument> {
    const what = `Journal entry in company code ${entry.companyCode}`;
    const date = toODataDate(entry.postingDate ?? todayIso());
    const draft = (await this.request(ctx, what, 'post', `${SERVICES.glPost}/FinsPostingGLHeaders`, undefined, {
      body: {
        CompanyCode: entry.companyCode,
        AccountingDocumentType: entry.documentType ?? 'SA',
        DocumentDate: date,
        PostingDate: date,
        TransactionCurrency: entry.currency,
        AccountingDocumentHeaderText: (entry.headerText ?? 'Prowess AI posting').slice(0, 25),
      },
    })) as ODataEntity;
    if (!str(draft.TmpId)) throw new SapError('BUSINESS_RULE', 'SAP did not accept the header of the journal entry.');
    for (const [index, line] of entry.lines.entries()) {
      await this.request(ctx, `${what}, line ${index + 1} (${line.glAccount})`, 'post', `${SERVICES.glPost}/FinsPostingGLItems`, undefined, {
        body: {
          TmpId: str(draft.TmpId),
          TmpIdType: str(draft.TmpIdType),
          AccountingDocumentItemRef: String(index + 1),
          CompanyCode: entry.companyCode,
          GLAccount: line.glAccount,
          GLAccountForInput: line.glAccount,
          [line.debitCredit === 'D' ? 'DebitAmountInTransCrcy' : 'CreditAmountInTransCrcy']: line.amount.toFixed(2),
          ...(line.costCenter && { CostCenter: line.costCenter }),
          DocumentItemText: (line.text ?? entry.headerText ?? '').slice(0, 50),
        },
      });
    }
    return this.postTemporaryDocument(ctx, what, entry.companyCode, draft);
  }

  /* ---------------- payments on account: custom RAP service ZAPI_FI_AGENTPAYMENT (OData V4) ---------------- */

  private async mapPayment(ctx: SapCallContext, e: ODataEntity): Promise<PaymentRequest> {
    const incoming = str(e.PaymentDirection) === 'I';
    const partner = incoming ? str(e.Customer) : str(e.Supplier);
    const partnerName = incoming ? await this.customerName(ctx, partner) : await this.getVendor(ctx, partner).then((v) => v.name, () => partner);
    return {
      id: str(e.PaymentUUID),
      direction: incoming ? 'INCOMING' : 'OUTGOING',
      companyCode: str(e.CompanyCode),
      partner,
      partnerName,
      bankAccount: str(e.BankGLAccount),
      amount: { amount: num(e.Amount), currency: str(e.Currency) },
      status: PAYMENT_STATUS[str(e.Status)] ?? 'NEW',
      ...(str(e.DocumentReferenceID) && { reference: str(e.DocumentReferenceID) }),
      ...(str(e.HeaderText) && { text: str(e.HeaderText) }),
      ...(str(e.AccountingDocument) && { accountingDocument: str(e.AccountingDocument) }),
      ...(str(e.FiscalYear).replace(/^0+$/, '') && { fiscalYear: str(e.FiscalYear) }),
      ...(str(e.Message) && { message: str(e.Message) }),
      createdBy: str(e.CreatedBy),
      ...(str(e.CreatedAt) && { createdOn: str(e.CreatedAt).slice(0, 10) }),
      ...(str(e.ApprovedBy) && { approvedBy: str(e.ApprovedBy) }),
    };
  }

  async listPaymentRequests(ctx: SapCallContext, query: PaymentRequestQuery): Promise<PaymentRequest[]> {
    const filter = [...(query.companyCode ? [`CompanyCode eq ${lit(query.companyCode)}`] : []), ...(query.status ? [`Status eq '${PAYMENT_STATUS_CODE[query.status]}'`] : [])].join(' and ');
    const res = (await this.requestV4(ctx, 'Payment requests', 'get', `${SERVICES.payment}/Payment`, {
      params: { ...(filter && { $filter: filter }), $orderby: 'CreatedAt desc', $top: '50' },
    })) as { value?: ODataEntity[] };
    return Promise.all((res.value ?? []).map((e) => this.mapPayment(ctx, e)));
  }

  async getPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    return this.mapPayment(ctx, (await this.requestV4(ctx, `Payment request ${id}`, 'get', `${SERVICES.payment}/${paymentKey(id)}`)) as ODataEntity);
  }

  async createPaymentRequest(ctx: SapCallContext, request: NewPaymentRequest): Promise<PaymentRequest> {
    const incoming = request.direction === 'INCOMING';
    const created = (await this.requestV4(ctx, `Payment request for ${incoming ? 'customer' : 'supplier'} ${request.partner}`, 'post', `${SERVICES.payment}/Payment`, {
      body: {
        PaymentDirection: incoming ? 'I' : 'O',
        CompanyCode: request.companyCode,
        ...(incoming ? { Customer: request.partner } : { Supplier: request.partner }),
        BankGLAccount: request.bankAccount,
        Amount: request.amount,
        Currency: request.currency,
        ...(request.reference && { DocumentReferenceID: request.reference.slice(0, 16) }),
        ...(request.text && { HeaderText: request.text.slice(0, 25) }),
      },
    })) as ODataEntity;
    return this.mapPayment(ctx, created);
  }

  /** Bound action of the payment service. The request is read again afterwards: the journal entry number is only drawn when SAP saves. */
  private async paymentAction(ctx: SapCallContext, id: string, action: 'approve' | 'reject' | 'post', what: string): Promise<PaymentRequest> {
    await this.requestV4(ctx, `${what} of payment request ${id}`, 'post', `${SERVICES.payment}/${paymentKey(id)}/SAP__self.${action}`, { body: {}, headers: { 'if-match': '*' } });
    return this.getPaymentRequest(ctx, id);
  }

  approvePaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    return this.paymentAction(ctx, id, 'approve', 'Approval');
  }

  rejectPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    return this.paymentAction(ctx, id, 'reject', 'Rejection');
  }

  postPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    return this.paymentAction(ctx, id, 'post', 'Posting');
  }

  /* ---------------- sales order entry, credit memo request ---------------- */

  private salesOrderBody(order: NewSalesOrder) {
    return {
      SalesOrderType: order.orderType ?? 'OR',
      SalesOrganization: order.salesOrganization,
      DistributionChannel: order.distributionChannel,
      OrganizationDivision: order.division,
      SoldToParty: order.soldTo,
      ...(order.customerReference && { PurchaseOrderByCustomer: order.customerReference }),
      ...(order.requestedDeliveryDate && { RequestedDeliveryDate: toODataDate(order.requestedDeliveryDate) }),
    };
  }

  async simulateSalesOrder(ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrderSimulation> {
    const e = (await this.request(ctx, `Sales order simulation for customer ${order.soldTo}`, 'post', `${SERVICES.salesSimulation}/A_SalesOrderSimulation`, undefined, {
      body: {
        ...this.salesOrderBody(order),
        to_Pricing: {},
        to_Credit: {},
        to_Item: { results: [{ SalesOrderItem: '10', Material: order.material, RequestedQuantity: String(order.quantity) }] },
      },
    })) as ODataEntity;
    const pricing = (e.to_Pricing ?? {}) as ODataEntity;
    const currency = str(pricing.TransactionCurrency) || str(e.TransactionCurrency);
    const items = results(e.to_Item).map((i) => ({
      material: str(i.Material),
      description: str(i.SalesOrderItemText) || str(i.Material),
      quantity: num(i.RequestedQuantity),
      unit: str(i.RequestedQuantityUnit),
      netValue: { amount: num(i.NetAmount), currency: str(i.TransactionCurrency) || currency },
      ...(i.ConfdDelivQtyInOrderQtyUnit !== undefined && { confirmedQuantity: num(i.ConfdDelivQtyInOrderQtyUnit) }),
    }));
    const creditCheck = str(((e.to_Credit ?? {}) as ODataEntity).TotalCreditCheckStatus);
    return {
      soldTo: order.soldTo,
      soldToName: await this.customerName(ctx, order.soldTo),
      netValue: { amount: pricing.TotalNetAmount !== undefined ? num(pricing.TotalNetAmount) : items.reduce((sum, i) => sum + i.netValue.amount, 0), currency },
      // SD credit status: A checked and in order, D released; B and C not in order.
      creditStatus: creditCheck === 'B' || creditCheck === 'C' ? 'BLOCKED' : creditCheck === 'A' || creditCheck === 'D' ? 'APPROVED' : 'NOT_CHECKED',
      items,
    };
  }

  async createSalesOrder(ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrder> {
    const created = (await this.request(ctx, `Sales order for customer ${order.soldTo}`, 'post', `${SERVICES.salesOrder}/A_SalesOrder`, undefined, {
      body: { ...this.salesOrderBody(order), to_Item: { results: [{ Material: order.material, RequestedQuantity: String(order.quantity) }] } },
    })) as ODataEntity;
    return this.getSalesOrder(ctx, str(created.SalesOrder));
  }

  /**
   * Price of a sales order item: the existing price condition is changed, or a manual one is added
   * when the item has none (which is what leaves an order incomplete).
   */
  async setSalesOrderItemPrice(ctx: SapCallContext, salesOrder: string, item: string, price: number, currency: string, conditionType?: string): Promise<SalesOrder> {
    const what = `Price of sales order ${salesOrder} item ${item}`;
    const itemKey = `SalesOrder=${lit(salesOrder)},SalesOrderItem=${lit(item)}`;
    const candidates = conditionType ? [conditionType] : PRICE_CONDITIONS;
    const conditions = results(await this.request(ctx, what, 'get', `${SERVICES.salesOrder}/A_SalesOrderItem(${itemKey})/to_PricingElement`, { $top: '100' }));
    const body = { ConditionRateValue: String(price), ConditionCurrency: currency };
    const existing = conditions.find((c) => candidates.includes(str(c.ConditionType)));
    if (existing) {
      const key = `${itemKey},PricingProcedureStep=${lit(str(existing.PricingProcedureStep))},PricingProcedureCounter=${lit(str(existing.PricingProcedureCounter))}`;
      await this.request(ctx, what, 'patch', `${SERVICES.salesOrder}/A_SalesOrderItemPrElement(${key})`, undefined, { body, headers: { 'if-match': '*' } });
      return this.getSalesOrder(ctx, salesOrder);
    }
    // No price condition yet: add the one the item's pricing procedure contains, trying them in order.
    for (const [index, type] of candidates.entries()) {
      try {
        await this.request(ctx, what, 'post', `${SERVICES.salesOrder}/A_SalesOrderItem(${itemKey})/to_PricingElement`, undefined, { body: { ConditionType: type, ...body } });
        return this.getSalesOrder(ctx, salesOrder);
      } catch (err) {
        const notInProcedure = err instanceof SapError && /missing in pricing procedure/i.test(err.message);
        if (!notInProcedure || index === candidates.length - 1) throw err;
      }
    }
    return this.getSalesOrder(ctx, salesOrder);
  }

  async updateSalesOrder(ctx: SapCallContext, salesOrder: string, change: SalesOrderChange): Promise<SalesOrder> {
    const what = `Change of sales order ${salesOrder}`;
    const header = {
      ...(change.customerReference && { PurchaseOrderByCustomer: change.customerReference }),
      ...(change.paymentTerms && { CustomerPaymentTerms: change.paymentTerms }),
      ...(change.incoterms && { IncotermsClassification: change.incoterms }),
      ...(change.incotermsLocation && { IncotermsLocation1: change.incotermsLocation, IncotermsTransferLocation: change.incotermsLocation }),
      ...(change.requestedDeliveryDate && { RequestedDeliveryDate: toODataDate(change.requestedDeliveryDate) }),
    };
    if (Object.keys(header).length) {
      await this.request(ctx, what, 'patch', `${SERVICES.salesOrder}/A_SalesOrder(${lit(salesOrder)})`, undefined, { body: header, headers: { 'if-match': '*' } });
    }
    const item = {
      ...(change.shippingPoint && { ShippingPoint: change.shippingPoint }),
      ...(change.storageLocation && { StorageLocation: change.storageLocation }),
    };
    if (Object.keys(item).length) {
      const order = await this.getSalesOrder(ctx, salesOrder);
      for (const i of order.items) {
        await this.request(ctx, what, 'patch', `${SERVICES.salesOrder}/A_SalesOrderItem(SalesOrder=${lit(salesOrder)},SalesOrderItem=${lit(i.item)})`, undefined, {
          body: item,
          headers: { 'if-match': '*' },
        });
      }
    }
    return this.getSalesOrder(ctx, salesOrder);
  }

  /** Item weights are read-only in the released sales order APIs; the custom action uses BAPI_SALESORDER_CHANGE. */
  async setSalesOrderItemWeight(ctx: SapCallContext, salesOrder: string, item: string, grossWeight: number, netWeight: number, weightUnit: string): Promise<SalesOrder> {
    const key = `SalesOrder=${lit(salesOrder.padStart(10, '0'))},SalesOrderItem=${lit(item.padStart(6, '0'))}`;
    await this.requestV4(ctx, `Weight of sales order ${salesOrder} item ${item}`, 'post', `${SERVICES.incompletion}/ItemWeight(${key})/SAP__self.setWeight`, {
      body: { GrossWeight: grossWeight, NetWeight: netWeight, WeightUnit: weightUnit },
    });
    return this.getSalesOrder(ctx, salesOrder);
  }

  async getIncompletionLog(ctx: SapCallContext, salesDocument: string): Promise<IncompletionEntry[]> {
    const res = (await this.requestV4(ctx, `Incompletion log of sales document ${salesDocument}`, 'get', `${SERVICES.incompletion}/IncompletionLog`, {
      params: { $filter: `SalesDocument eq ${lit(salesDocument.padStart(10, '0'))}`, $top: '200' },
    })) as { value?: ODataEntity[] };
    const flag = (v: unknown) => v === true || v === 'X';
    return (res.value ?? []).map((e) => {
      const item = str(e.SalesDocumentItem).replace(/^0+/, '');
      const partner = str(e.PartnerFunction);
      return {
        ...(item && { item }),
        field: str(e.FieldLabel) || `${str(e.TableName)}-${str(e.FieldName)}`,
        table: str(e.TableName),
        fieldName: str(e.FieldName),
        ...(partner && { partnerFunction: partner }),
        blocksDelivery: flag(e.BlocksDelivery),
        blocksBilling: flag(e.BlocksBilling),
      };
    });
  }

  async releaseCreditBlock(): Promise<SalesOrder> {
    return this.notSupported('Releasing a credit block (release the document in SAP Credit Management, for example with the Manage Documented Credit Decisions app)');
  }

  async createCreditMemoRequest(ctx: SapCallContext, billingDocument: string, reason: string): Promise<CreditMemoRequest> {
    const what = `Credit memo request for billing document ${billingDocument}`;
    const b = (await this.request(ctx, `Billing document ${billingDocument}`, 'get', `${SERVICES.billing}/A_BillingDocument(${lit(billingDocument)})`, { $expand: 'to_Item' })) as ODataEntity;
    if (b.BillingDocumentIsCancelled === true) throw new SapError('BUSINESS_RULE', `Billing document ${billingDocument} is cancelled, so no credit memo can be requested for it.`);
    const soldTo = str(b.SoldToParty);
    const created = (await this.request(ctx, what, 'post', `${SERVICES.creditMemo}/A_CreditMemoRequest`, undefined, {
      body: {
        CreditMemoRequestType: 'CR',
        SalesOrganization: str(b.SalesOrganization),
        DistributionChannel: str(b.DistributionChannel),
        OrganizationDivision: str(b.Division),
        SoldToParty: soldTo,
        SDDocumentReason: reason,
        to_Item: {
          results: results(b.to_Item).map((i) => ({
            Material: str(i.Material),
            RequestedQuantity: str(i.BillingQuantity),
            ReferenceSDDocument: str(b.BillingDocument),
            ReferenceSDDocumentItem: str(i.BillingDocumentItem),
          })),
        },
      },
    })) as ODataEntity;
    return {
      number: str(created.CreditMemoRequest),
      billingDocument: str(b.BillingDocument),
      soldTo,
      soldToName: await this.customerName(ctx, soldTo),
      netValue: { amount: num(created.TotalNetAmount ?? b.TotalNetAmount), currency: str(created.TransactionCurrency) || str(b.TransactionCurrency) },
      reason,
    };
  }

  /* ---------------- reversals ---------------- */

  async reverseGoodsReceipt(ctx: SapCallContext, materialDocument: string, year: string): Promise<Reversal> {
    const created = (await this.request(ctx, `Reversal of material document ${materialDocument}`, 'post', `${SERVICES.gr}/Cancel`, {
      MaterialDocumentYear: lit(year),
      MaterialDocument: lit(materialDocument),
      PostingDate: dateTimeLit(todayIso()),
    })) as ODataEntity;
    const header = (created.Cancel ?? created) as ODataEntity;
    return { document: str(header.MaterialDocument), ...(str(header.MaterialDocumentYear) && { year: str(header.MaterialDocumentYear) }), reversedDocument: materialDocument };
  }

  async reverseSupplierInvoice(ctx: SapCallContext, number: string, fiscalYear: string, reason: string): Promise<Reversal> {
    const created = (await this.request(ctx, `Reversal of supplier invoice ${number}`, 'post', `${SERVICES.invoice}/Cancel`, {
      FiscalYear: lit(fiscalYear),
      SupplierInvoice: lit(number),
      ReversalReason: lit(reason),
      PostingDate: dateTimeLit(todayIso()),
    })) as ODataEntity;
    const result = (created.Cancel ?? created) as ODataEntity;
    return { document: str(result.ReverseDocument), ...(str(result.FiscalYear) && { year: str(result.FiscalYear) }), reversedDocument: number };
  }

  async reverseGoodsIssue(ctx: SapCallContext, delivery: string): Promise<OutboundDelivery> {
    await this.request(ctx, `Goods issue reversal for delivery ${delivery}`, 'post', `${SERVICES.delivery}/ReverseGoodsIssue`, { DeliveryDocument: lit(delivery) }, { headers: { 'if-match': '*' } });
    return this.getDelivery(ctx, delivery);
  }

  async cancelBillingDocument(): Promise<Reversal> {
    return this.notSupported('Cancelling a billing document (cancel it in SAP with transaction VF11)');
  }

  async releaseInvoiceBlock(ctx: SapCallContext, number: string, fiscalYear: string): Promise<Invoice> {
    await this.request(ctx, `Release of invoice ${number}`, 'post', `${SERVICES.invoice}/Release`, {
      SupplierInvoice: lit(number),
      FiscalYear: lit(fiscalYear),
    });
    return this.getInvoice(ctx, number, fiscalYear);
  }

  async addInvoiceNote(): Promise<{ noteId: string }> {
    return this.notSupported('Adding invoice notes (enable an attachment/note API and extend this gateway)');
  }
}
