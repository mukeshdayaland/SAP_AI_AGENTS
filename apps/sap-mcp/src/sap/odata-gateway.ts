import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { M, type Logger } from '@prowess/observability';
import {
  SapError,
  type Equipment,
  type GLBalance,
  type GoodsReceipt,
  type Invoice,
  type MaintenanceEvent,
  type MaintenanceNotification,
  type PurchaseOrder,
  type PurchaseRequisition,
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
} as const;

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
