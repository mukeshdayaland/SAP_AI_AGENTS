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
  /** The supplier's own invoice number. */
  reference?: string;
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

export interface NewPurchaseRequisition {
  material: string;
  plant: string;
  quantity: number;
  deliveryDate?: string;
}

export interface NewPurchaseOrder {
  supplier: string;
  material: string;
  plant: string;
  quantity: number;
  companyCode: string;
  purchasingOrganization: string;
  purchasingGroup: string;
  /** Net price per unit. Omit to let SAP take it from the info record. */
  netPrice?: number;
}

export interface NewSupplierInvoice {
  purchaseOrder: string;
  /** The supplier's own invoice number. */
  reference: string;
  /** Gross amount as printed on the supplier's invoice, in the purchase order currency. */
  grossAmount: number;
  taxCode?: string;
  invoiceDate?: string;
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
  shippingPoint?: string;
  storageLocation?: string;
  grossWeight?: number;
  netWeight?: number;
  weightUnit?: string;
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

/** Header data of a sales order that can be changed (VA02); the shipping point applies to every item. */
export interface SalesOrderChange {
  customerReference?: string;
  paymentTerms?: string;
  incoterms?: string;
  incotermsLocation?: string;
  requestedDeliveryDate?: string;
  shippingPoint?: string;
  storageLocation?: string;
}

/** Data still missing in a sales document: one line of its incompletion log (VA02, Edit > Incompletion log). */
export interface IncompletionEntry {
  /** Item number; absent for header data. */
  item?: string;
  /** Field label, e.g. "Storage Location". */
  field: string;
  table: string;
  fieldName: string;
  partnerFunction?: string;
  blocksDelivery: boolean;
  blocksBilling: boolean;
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

export type PaymentStatus = 'NEW' | 'APPROVED' | 'POSTED' | 'REJECTED';

/** A payment on account (F-28 incoming, F-53 outgoing) that one person requests and another approves before it is posted. */
export interface PaymentRequest {
  id: string;
  direction: 'INCOMING' | 'OUTGOING';
  companyCode: string;
  /** Customer of an incoming payment, supplier of an outgoing one. */
  partner: string;
  partnerName?: string;
  /** Bank G/L account the payment is posted to. */
  bankAccount: string;
  amount: Amount;
  status: PaymentStatus;
  reference?: string;
  text?: string;
  accountingDocument?: string;
  fiscalYear?: string;
  message?: string;
  createdBy: string;
  createdOn?: string;
  approvedBy?: string;
}

export interface NewPaymentRequest {
  direction: PaymentRequest['direction'];
  companyCode: string;
  partner: string;
  amount: number;
  currency: string;
  bankAccount: string;
  reference?: string;
  text?: string;
}

export interface PaymentRequestQuery {
  companyCode?: string;
  status?: PaymentStatus;
}

export interface NewSalesOrder {
  soldTo: string;
  material: string;
  quantity: number;
  salesOrganization: string;
  distributionChannel: string;
  division: string;
  /** Defaults to the standard order type OR. */
  orderType?: string;
  customerReference?: string;
  requestedDeliveryDate?: string;
}

/** Result of pricing, availability and credit checks for an order that is not saved. */
export interface SalesOrderSimulation {
  soldTo: string;
  soldToName: string;
  netValue: Amount;
  taxAmount?: Amount;
  creditStatus: SalesOrder['creditStatus'];
  items: { material: string; description: string; quantity: number; unit: string; netValue: Amount; confirmedQuantity?: number }[];
}

export interface CreditMemoRequest {
  number: string;
  billingDocument: string;
  soldTo: string;
  soldToName: string;
  netValue: Amount;
  reason: string;
}

/** A document that reverses another one. */
export interface Reversal {
  document: string;
  year?: string;
  reversedDocument: string;
}

/* ---------------- finance analysis (G/L, aging, payment run, fixed assets, bank) ---------------- */

export interface GLAccountInfo {
  account: string;
  name: string;
  longName?: string;
  companyCode?: string;
  chartOfAccounts?: string;
}

/** Debit and credit postings of one G/L account over a range of periods. */
export interface AccountActivity {
  account: string;
  name: string;
  debit: number;
  credit: number;
  /** Debit minus credit. */
  net: number;
  currency: string;
}

/** Open receivables of one customer by days overdue. */
export interface ReceivablesAging {
  customer: string;
  total: number;
  /** Not due or up to 30 days overdue. */
  upTo30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  currency: string;
}

export const AGING_BUCKETS = ['Not due', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'] as const;

/** Open payables by days overdue at a key date. Amounts are positive payables. */
export interface PayablesAging {
  companyCode: string;
  keyDate: string;
  currency: string;
  buckets: { bucket: (typeof AGING_BUCKETS)[number]; amount: number; items: number }[];
  suppliers: { supplier: string; name?: string; amount: number; overdue: number; items: number }[];
  /** True when SAP returned more items than were read. */
  truncated: boolean;
}

export interface InvoiceApproval {
  invoice: string;
  fiscalYear: string;
  supplier: string;
  supplierName: string;
  gross: Amount;
  postingDate?: string;
  status: string;
  blocked: boolean;
  approvalStatus?: string;
  approver?: string;
}

/** Payment run (F110) proposal: what would be paid, and what SAP excluded and why. */
export interface PaymentRunProposal {
  runs: { runId: string; runDate?: string; isProposal: boolean; paymentMethod?: string; amount: Amount }[];
  items: { runId: string; supplier: string; supplierName?: string; document: string; paymentMethod?: string; amount: Amount }[];
  exceptions: { runId: string; supplier: string; supplierName?: string; document: string; blockingReason?: string; message: string; amount: Amount }[];
}

/** One purchase order item with an open balance on the GR/IR clearing account. */
export interface GRIRCase {
  purchaseOrder: string;
  item: string;
  supplier: string;
  supplierName?: string;
  status?: string;
  priority?: string;
  rootCause?: string;
  dueDays?: number;
  openItems: number;
  balance: Amount;
}

export interface BankReconciliationAccount {
  companyCode: string;
  glAccount: string;
  glAccountName?: string;
  houseBank: string;
  houseBankAccount: string;
  openItems: number;
  openBalance: Amount;
}

export interface DepreciationOverview {
  companyCode: string;
  fiscalYear: string;
  assets: { asset: string; description: string; posted: number; unposted: number; netBookValue: number; currency: string }[];
  /** Periods whose planned depreciation has not been posted. */
  exceptions: { asset: string; period: string; status: string; amount: number; currency: string }[];
  /** True when the company code has more assets than were examined. */
  truncated: boolean;
}

/** Open items of one customer or supplier that offset each other. */
export interface ClearingRequest {
  companyCode: string;
  accountType: 'CUSTOMER' | 'SUPPLIER';
  account: string;
}

export interface NewJournalEntry {
  companyCode: string;
  currency: string;
  postingDate?: string;
  documentType?: string;
  headerText?: string;
  lines: { glAccount: string; debitCredit: 'D' | 'C'; amount: number; costCenter?: string; text?: string }[];
}

/** A document SAP created for a posting. */
export interface PostedDocument {
  document: string;
  fiscalYear?: string;
  companyCode: string;
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

  getInvoicesForPurchaseOrder(ctx: SapCallContext, purchaseOrder: string): Promise<Invoice[]>;
  createPurchaseRequisition(ctx: SapCallContext, requisition: NewPurchaseRequisition): Promise<PurchaseRequisition>;
  createPurchaseOrder(ctx: SapCallContext, order: NewPurchaseOrder): Promise<PurchaseOrder>;
  /** Posts a goods receipt (movement type 101) for all open quantities of a purchase order (MIGO). */
  postGoodsReceipt(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]>;
  /** Posts a supplier invoice against a purchase order (MIRO). SAP may post it blocked for payment. */
  createSupplierInvoice(ctx: SapCallContext, invoice: NewSupplierInvoice): Promise<Invoice>;

  /** Creates an outbound delivery for all open items of a sales order (VL01N). */
  createDelivery(ctx: SapCallContext, salesOrder: string): Promise<OutboundDelivery>;
  postGoodsIssue(ctx: SapCallContext, delivery: string): Promise<OutboundDelivery>;
  /** Bills a goods-issued delivery (VF01) and releases the billing document to accounting. */
  createBillingDocument(ctx: SapCallContext, delivery: string): Promise<BillingDocument>;

  searchGLAccounts(ctx: SapCallContext, searchText: string, companyCode?: string): Promise<GLAccountInfo[]>;
  /** Postings per G/L account for a period range of a fiscal year (leading ledger). */
  getAccountActivity(ctx: SapCallContext, companyCode: string, fiscalYear: string, periodFrom?: string, periodTo?: string): Promise<AccountActivity[]>;
  getReceivablesAging(ctx: SapCallContext, companyCode: string, currency: string): Promise<ReceivablesAging[]>;
  getPayablesAging(ctx: SapCallContext, companyCode: string, keyDate?: string): Promise<PayablesAging>;
  listInvoiceApprovals(ctx: SapCallContext, companyCode: string): Promise<InvoiceApproval[]>;
  getPaymentRunProposal(ctx: SapCallContext, companyCode: string, runId?: string): Promise<PaymentRunProposal>;
  listGRIRCases(ctx: SapCallContext, companyCode: string, fiscalYear?: string): Promise<GRIRCase[]>;
  listCreditBlockedOrders(ctx: SapCallContext, customer?: string): Promise<SalesOrder[]>;
  getBankReconciliation(ctx: SapCallContext, companyCode: string): Promise<BankReconciliationAccount[]>;
  getDepreciationOverview(ctx: SapCallContext, companyCode: string, fiscalYear: string): Promise<DepreciationOverview>;
  /** Posts a clearing document for the open items of one account. SAP selects the items of the account. */
  clearOpenItems(ctx: SapCallContext, request: ClearingRequest): Promise<PostedDocument>;
  postJournalEntry(ctx: SapCallContext, entry: NewJournalEntry): Promise<PostedDocument>;

  listPaymentRequests(ctx: SapCallContext, query: PaymentRequestQuery): Promise<PaymentRequest[]>;
  getPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest>;
  createPaymentRequest(ctx: SapCallContext, request: NewPaymentRequest): Promise<PaymentRequest>;
  /** SAP refuses approval by the person who created the request. */
  approvePaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest>;
  rejectPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest>;
  /** Posts an approved request as a journal entry (document type DZ or KZ). */
  postPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest>;

  simulateSalesOrder(ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrderSimulation>;
  createSalesOrder(ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrder>;
  releaseCreditBlock(ctx: SapCallContext, salesOrder: string): Promise<SalesOrder>;
  /** Changes header data of a sales order (VA02), for example to complete it before delivery. */
  updateSalesOrder(ctx: SapCallContext, salesOrder: string, change: SalesOrderChange): Promise<SalesOrder>;
  /** Sets the gross and net weight of a sales order item (VA02, item, Shipping tab). */
  setSalesOrderItemWeight(ctx: SapCallContext, salesOrder: string, item: string, grossWeight: number, netWeight: number, weightUnit: string): Promise<SalesOrder>;
  /** The incompletion log of a sales document: data SAP still needs before delivery or billing. */
  getIncompletionLog(ctx: SapCallContext, salesDocument: string): Promise<IncompletionEntry[]>;
  /**
   * Sets the price per unit of a sales order item through its price condition (VA02). Without a condition type,
   * the price condition of the item's pricing procedure is used: PPR0 (S/4HANA) or PR00 (classic).
   */
  setSalesOrderItemPrice(ctx: SapCallContext, salesOrder: string, item: string, price: number, currency: string, conditionType?: string): Promise<SalesOrder>;
  createCreditMemoRequest(ctx: SapCallContext, billingDocument: string, reason: string): Promise<CreditMemoRequest>;

  reverseGoodsReceipt(ctx: SapCallContext, materialDocument: string, year: string): Promise<Reversal>;
  reverseSupplierInvoice(ctx: SapCallContext, number: string, fiscalYear: string, reason: string): Promise<Reversal>;
  reverseGoodsIssue(ctx: SapCallContext, delivery: string): Promise<OutboundDelivery>;
  cancelBillingDocument(ctx: SapCallContext, number: string): Promise<Reversal>;

  releaseInvoiceBlock(ctx: SapCallContext, number: string, fiscalYear: string): Promise<Invoice>;
  addInvoiceNote(ctx: SapCallContext, number: string, fiscalYear: string, note: string): Promise<{ noteId: string }>;
}
