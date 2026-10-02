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

/** SAP processing status (SD status values '', A, B, C). */
export type ProcessStatus = 'NOT_RELEVANT' | 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE';

export interface SalesOrderItem {
  item: string;
  material: string;
  description: string;
  quantity: number;
  unit: string;
  netValue: Amount;
  plant?: string;
}

export interface SalesOrder {
  number: string;
  orderType: string;
  salesOrganization: string;
  distributionChannel: string;
  division: string;
  soldTo: string;
  soldToName: string;
  customerReference?: string;
  netValue: Amount;
  createdOn?: string;
  requestedDeliveryDate?: string;
  paymentTerms?: string;
  incoterms?: string;
  deliveryStatus: ProcessStatus;
  billingStatus: ProcessStatus;
  creditStatus: 'NOT_CHECKED' | 'APPROVED' | 'BLOCKED';
  deliveryBlock?: string;
  billingBlock?: string;
  items: SalesOrderItem[];
}

/** One document in the order-to-cash chain that follows a sales order. */
export interface DocumentFlowStep {
  category: 'DELIVERY' | 'GOODS_ISSUE' | 'BILLING' | 'ACCOUNTING' | 'OTHER';
  document: string;
  date?: string;
  status?: string;
}

export interface OutboundDelivery {
  number: string;
  shipTo: string;
  shipToName: string;
  salesOrder?: string;
  shippingPoint?: string;
  plannedGoodsIssueDate?: string;
  actualGoodsIssueDate?: string;
  goodsIssueStatus: ProcessStatus;
  pickingStatus: ProcessStatus;
  items: { item: string; material: string; description: string; quantity: number; unit: string; plant?: string; storageLocation?: string }[];
}

export interface BillingDocument {
  number: string;
  billingType: string;
  payer: string;
  payerName: string;
  billingDate: string;
  netValue: Amount;
  taxAmount?: Amount;
  companyCode: string;
  fiscalYear?: string;
  accountingDocument?: string;
  postedToAccounting: boolean;
  cancelled: boolean;
  salesOrder?: string;
  items: { item: string; material: string; description: string; quantity: number; unit: string; netValue: Amount }[];
}

export interface Customer {
  id: string;
  name: string;
  country?: string;
  city?: string;
  orderBlocked: boolean;
  deliveryBlocked: boolean;
  billingBlocked: boolean;
  postingBlocked: boolean;
}

export interface CreditProfile {
  customer: string;
  customerName: string;
  creditSegment: string;
  limit: Amount;
  exposure: Amount;
  /** Where `exposure` comes from: SAP Credit Management, or the sum of open receivables as an approximation. */
  exposureBasis: 'CREDIT_MANAGEMENT' | 'OPEN_RECEIVABLES';
  riskClass?: string;
  blocked: boolean;
}

export type OpenItemAccountType = 'CUSTOMER' | 'SUPPLIER' | 'GL';

export interface OpenItemQuery {
  accountType: OpenItemAccountType;
  companyCode: string;
  /** Customer, supplier or G/L account. Omit to list across all accounts of the type. */
  account?: string;
  status: 'OPEN' | 'CLEARED' | 'ALL';
  /** Only items due on or before this date (YYYY-MM-DD). */
  dueBy?: string;
}

/** A line item of a customer, supplier or open-item-managed G/L account (FBL5N / FBL1N / FBL3N). */
export interface OpenItem {
  companyCode: string;
  fiscalYear: string;
  document: string;
  item: string;
  documentType: string;
  accountType: OpenItemAccountType;
  account: string;
  accountName?: string;
  postingDate: string;
  dueDate?: string;
  /** Signed: receivables and debits positive, payables and credits negative. */
  amount: Amount;
  clearingDocument?: string;
  clearingDate?: string;
  assignment?: string;
  text?: string;
  paymentBlock?: string;
}

export interface AccountingDocument {
  companyCode: string;
  fiscalYear: string;
  number: string;
  documentType: string;
  postingDate: string;
  documentDate?: string;
  reference?: string;
  items: {
    item: string;
    /** Customer, supplier or G/L account number as shown in the entry view. */
    account: string;
    description?: string;
    /** Signed: debit positive, credit negative. */
    amount: Amount;
    debitCredit: 'D' | 'C';
    profitCenter?: string;
    costCenter?: string;
  }[];
}

export interface MaterialStock {
  material: string;
  description?: string;
  plant: string;
  storageLocation?: string;
  unrestricted: number;
  qualityInspection: number;
  blocked: number;
  unit: string;
}

export interface InfoRecord {
  infoRecord: string;
  supplier: string;
  supplierName?: string;
  material: string;
  purchasingOrganization?: string;
  plant?: string;
  netPrice: Amount;
  plannedDeliveryDays?: number;
  lastPurchaseOrder?: string;
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

  getSalesOrder(ctx: SapCallContext, number: string): Promise<SalesOrder>;
  /** Sales orders that are not yet completely delivered or billed, or are blocked. */
  listOpenSalesOrders(ctx: SapCallContext, salesOrganization?: string): Promise<SalesOrder[]>;
  getSalesOrderFlow(ctx: SapCallContext, number: string): Promise<DocumentFlowStep[]>;
  getDelivery(ctx: SapCallContext, number: string): Promise<OutboundDelivery>;
  getBillingDocument(ctx: SapCallContext, number: string): Promise<BillingDocument>;
  getCustomer(ctx: SapCallContext, id: string): Promise<Customer>;
  getCreditProfile(ctx: SapCallContext, customer: string): Promise<CreditProfile>;
  listOpenItems(ctx: SapCallContext, query: OpenItemQuery): Promise<OpenItem[]>;
  getAccountingDocument(ctx: SapCallContext, companyCode: string, fiscalYear: string, number: string): Promise<AccountingDocument>;
  getMaterialStock(ctx: SapCallContext, material: string, plant?: string): Promise<MaterialStock[]>;
  getInfoRecords(ctx: SapCallContext, material: string, supplier?: string): Promise<InfoRecord[]>;
  listBlockedInvoices(ctx: SapCallContext, companyCode: string): Promise<Invoice[]>;

  releaseInvoiceBlock(ctx: SapCallContext, number: string, fiscalYear: string): Promise<Invoice>;
  addInvoiceNote(ctx: SapCallContext, number: string, fiscalYear: string, note: string): Promise<{ noteId: string }>;
}
