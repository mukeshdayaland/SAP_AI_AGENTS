import type { PrincipalAssertion } from '@prowess/security';

/** SAP-neutral domain model shared by the mock and OData gateways. */

export interface Amount {
  amount: number;
  currency: string;
}

export interface Invoice {
  number: string;
  fiscalYear: string;
  companyCode: string;
  vendorId: string;
  vendorName: string;
  gross: Amount;
  postingDate?: string;
  dueDate?: string;
  status: 'OPEN' | 'PAYMENT_BLOCKED' | 'PARKED' | 'PAID' | 'REVERSED';
  paymentBlock: { code: string; description: string } | null;
  purchaseOrder?: string;
  /** Item-level verification issues that cause/justify a block. */
  varianceChecks?: { type: 'PRICE' | 'QUANTITY' | 'DATE' | 'OTHER'; message: string; withinTolerance: boolean }[];
  paidOn?: string;
  paymentDocument?: string;
}

export interface Vendor {
  id: string;
  name: string;
  country: string;
  city?: string;
  paymentTerms?: string;
  postingBlocked: boolean;
  paymentBlocked: boolean;
  openItems?: Amount;
  overdueItems?: Amount;
  riskRating?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface PurchaseOrderItem {
  item: string;
  material: string;
  description: string;
  quantity: number;
  unit: string;
  netPrice: Amount;
  netValue: Amount;
}

export interface PurchaseOrder {
  number: string;
  vendorId: string;
  vendorName: string;
  value: Amount;
  status: 'DRAFT' | 'AWAITING_APPROVAL' | 'RELEASED' | 'PARTIALLY_DELIVERED' | 'DELIVERED' | 'CLOSED';
  createdOn: string;
  purchasingGroup?: string;
  companyCode: string;
  items: PurchaseOrderItem[];
}

export interface PurchaseRequisition {
  number: string;
  requester: string;
  value: Amount;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CONVERTED';
  createdOn: string;
  description: string;
}

export interface GoodsReceipt {
  materialDocument: string;
  year: string;
  purchaseOrder: string;
  item: string;
  postingDate: string;
  quantity: number;
  unit: string;
  value?: Amount;
}

export interface GLBalance {
  account: string;
  description: string;
  companyCode: string;
  fiscalYear: string;
  period: string;
  debit: Amount;
  credit: Amount;
  balance: Amount;
}

export interface Equipment {
  number: string;
  description: string;
  functionalLocation?: string;
  manufacturer?: string;
  status: string;
  criticality?: 'A' | 'B' | 'C';
}

export interface MaintenanceNotification {
  number: string;
  type: string;
  description: string;
  equipment?: string;
  priority: string;
  status: string;
  reportedOn: string;
}

export interface WorkOrder {
  number: string;
  description: string;
  equipment?: string;
  orderType: string;
  priority: string;
  status: string;
  plannedStart?: string;
  plannedEnd?: string;
  plannedCost?: Amount;
}

export interface MaintenanceEvent {
  date: string;
  kind: 'NOTIFICATION' | 'WORK_ORDER' | 'MEASUREMENT';
  reference: string;
  title: string;
  detail?: string;
  severity?: 'neutral' | 'positive' | 'warning' | 'critical';
}

export interface SearchHit {
  objectType: string;
  objectId: string;
  title: string;
  subtitle?: string;
}

export interface SystemInfo {
  systemId: string;
  description: string;
  release: string;
  client?: string;
  mock: boolean;
}

/** Everything a gateway needs to act on behalf of the user. */
export interface SapCallContext {
  principal: PrincipalAssertion;
  /** End-user XSUAA token for principal propagation (absent in local dev). */
  userJwt?: string;
  correlationId: string;
}

export type SapErrorCode = 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'UNAVAILABLE' | 'NOT_SUPPORTED' | 'BUSINESS_RULE' | 'INVALID_INPUT';

/** Raised by gateways. `message` is safe to show to the user. */
export class SapError extends Error {
  constructor(
    readonly code: SapErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SapError';
  }
}

export interface SapGateway {
  readonly systemId: string;
  readonly mock: boolean;
  systemInfo(): Promise<SystemInfo>;

  getInvoice(ctx: SapCallContext, number: string, fiscalYear?: string): Promise<Invoice>;
  getVendor(ctx: SapCallContext, id: string): Promise<Vendor>;
  getGLBalance(ctx: SapCallContext, account: string, companyCode: string, fiscalYear: string, period?: string): Promise<GLBalance>;
  getPurchaseOrder(ctx: SapCallContext, number: string): Promise<PurchaseOrder>;
  getPurchaseRequisition(ctx: SapCallContext, number: string): Promise<PurchaseRequisition>;
  getGoodsReceipts(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]>;
  getEquipment(ctx: SapCallContext, number: string): Promise<Equipment>;
  getNotification(ctx: SapCallContext, number: string): Promise<MaintenanceNotification>;
  getWorkOrder(ctx: SapCallContext, number: string): Promise<WorkOrder>;
  getMaintenanceHistory(ctx: SapCallContext, equipment: string): Promise<MaintenanceEvent[]>;
  search(ctx: SapCallContext, query: string): Promise<SearchHit[]>;

  releaseInvoiceBlock(ctx: SapCallContext, number: string, fiscalYear: string): Promise<Invoice>;
  addInvoiceNote(ctx: SapCallContext, number: string, fiscalYear: string, note: string): Promise<{ noteId: string }>;
}
