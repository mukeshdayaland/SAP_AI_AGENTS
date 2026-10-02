import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { M, type Logger } from '@prowess/observability';
import {
  SapError,
  type AccountingDocument,
  type BillingDocument,
  type CreditProfile,
  type Customer,
  type DocumentFlowStep,
  type Equipment,
  type GLBalance,
  type GoodsReceipt,
  type InfoRecord,
  type Invoice,
  type MaintenanceEvent,
  type MaintenanceNotification,
  type MaterialStock,
  type OpenItem,
  type OpenItemQuery,
  type OutboundDelivery,
  type ProcessStatus,
  type PurchaseOrder,
  type PurchaseRequisition,
  type SalesOrder,
  type SapCallContext,
  type SapGateway,
  type SearchHit,
  type SystemInfo,
  type Vendor,
  type WorkOrder,
} from './model.js';

/**
 * S/4HANA gateway over released OData V2 APIs, reached through the BTP
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
} as const;

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

  private async request(
    ctx: SapCallContext,
    what: string,
    method: 'get' | 'post',
    url: string,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const started = Date.now();
    try {
      const res = await executeHttpRequest(
        this.destination(ctx),
        {
          method,
          url,
          params: { $format: 'json', ...params },
          headers: { accept: 'application/json', 'x-correlation-id': ctx.correlationId },
          timeout: 20_000,
        },
        { fetchCsrfToken: method !== 'get' },
      );
      return (res.data as { d?: unknown }).d ?? res.data;
    } catch (err) {
      if (err instanceof SapError) throw err;
      const status = statusOf(err);
      this.cfg.logger.warn('sap.request_failed', { what, status, error: (err as Error).message });
      if (status === 404) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
      if (status === 401 || status === 403) throw new SapError('NOT_AUTHORIZED', `SAP denied access to ${what}.`);
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
        $expand: 'to_SupplierInvoiceItemPurOrdRef',
      })) as ODataEntity;
    } else {
      const res = (await this.request(ctx, what, 'get', `${SERVICES.invoice}/A_SupplierInvoice`, {
        $filter: `SupplierInvoice eq ${lit(number)}`,
        $orderby: 'FiscalYear desc',
        $top: '1',
        $expand: 'to_SupplierInvoiceItemPurOrdRef',
      })) as { results?: ODataEntity[] };
      const first = res.results?.[0];
      if (!first) throw new SapError('NOT_FOUND', `${what} was not found in SAP.`);
      e = first;
    }
    const block = String(e.PaymentBlockingReason ?? '').trim();
    const poRefs = ((e.to_SupplierInvoiceItemPurOrdRef as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];
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

  async getGLBalance(): Promise<GLBalance> {
    return this.notSupported('G/L balances (configure a CDS view such as C_TRIALBALANCE_CDS and extend this gateway)');
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
