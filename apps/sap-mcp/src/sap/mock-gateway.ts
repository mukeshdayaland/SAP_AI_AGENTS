import { randomUUID } from 'node:crypto';
import {
  SCENARIO_BILLING,
  SCENARIO_COMPANY_CODE,
  SCENARIO_CREDIT,
  SCENARIO_CUSTOMERS,
  SCENARIO_DELIVERIES,
  SCENARIO_FLOWS,
  SCENARIO_GOODS_RECEIPTS,
  SCENARIO_INFO_RECORDS,
  SCENARIO_INVOICES,
  SCENARIO_JOURNALS,
  SCENARIO_LINE_ITEMS,
  SCENARIO_PURCHASE_ORDERS,
  SCENARIO_SALES_ORDERS,
  SCENARIO_STOCK,
  SCENARIO_VENDORS,
} from './mock-scenarios.js';
import {
  AGING_BUCKETS,
  SapError,
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
  type PostedDocument,
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
  type WorkOrder,
} from './model.js';

/**
 * In-memory S/4HANA stand-in for local development, demos and CI.
 *
 * All data is fictitious and every response is flagged `mock: true`.
 * It also simulates SAP's *own* authorization checks (company-code scope and
 * a release permission) so the UI and orchestrator are exercised against
 * "SAP says no" outcomes that an AI application role cannot override.
 */

const SAR = (amount: number) => ({ amount, currency: 'SAR' });

const VENDORS: Vendor[] = [
  {
    id: '1000123',
    name: 'ABC Trading LLC',
    country: 'SA',
    city: 'Riyadh',
    paymentTerms: 'NT45',
    postingBlocked: false,
    paymentBlocked: false,
    openItems: SAR(1_214_600),
    overdueItems: SAR(86_400),
    riskRating: 'MEDIUM',
  },
  {
    id: '1000456',
    name: 'Gulf Industrial Supplies',
    country: 'AE',
    city: 'Dubai',
    paymentTerms: 'NT30',
    postingBlocked: false,
    paymentBlocked: false,
    openItems: SAR(312_900),
    overdueItems: SAR(0),
    riskRating: 'LOW',
  },
  ...SCENARIO_VENDORS,
];

const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    number: '4500012345',
    vendorId: '1000123',
    vendorName: 'ABC Trading LLC',
    value: SAR(1_420_000),
    status: 'PARTIALLY_DELIVERED',
    createdOn: '2026-08-24',
    purchasingGroup: 'P01',
    companyCode: '1000',
    items: [
      { item: '00010', material: 'RM-40021', description: 'Stainless steel coil 316L', quantity: 200, unit: 'TO', netPrice: SAR(2_050), netValue: SAR(410_000) },
      { item: '00020', material: 'RM-40022', description: 'Stainless steel sheet 304', quantity: 500, unit: 'TO', netPrice: SAR(2_020), netValue: SAR(1_010_000) },
    ],
  },
  {
    number: '4500012399',
    vendorId: '1000456',
    vendorName: 'Gulf Industrial Supplies',
    value: SAR(212_500),
    status: 'AWAITING_APPROVAL',
    createdOn: '2026-09-24',
    purchasingGroup: 'P02',
    companyCode: '1000',
    items: [{ item: '00010', material: 'SP-10090', description: 'Pump mechanical seal kit', quantity: 50, unit: 'EA', netPrice: SAR(4_250), netValue: SAR(212_500) }],
  },
  ...SCENARIO_PURCHASE_ORDERS,
];

const GOODS_RECEIPTS: GoodsReceipt[] = [
  { materialDocument: '5000045678', year: '2026', purchaseOrder: '4500012345', item: '00010', postingDate: '2026-09-02', quantity: 120, unit: 'TO', value: SAR(246_000) },
  { materialDocument: '5000045901', year: '2026', purchaseOrder: '4500012345', item: '00010', postingDate: '2026-09-15', quantity: 60, unit: 'TO', value: SAR(123_000) },
  ...SCENARIO_GOODS_RECEIPTS,
];

const INVOICES: Invoice[] = [
  {
    number: '5100012345',
    fiscalYear: '2026',
    companyCode: '1000',
    vendorId: '1000123',
    vendorName: 'ABC Trading LLC',
    gross: SAR(428_350),
    postingDate: '2026-09-18',
    dueDate: '2026-11-02',
    status: 'PAYMENT_BLOCKED',
    paymentBlock: { code: 'R', description: 'Invoice verification' },
    purchaseOrder: '4500012345',
    varianceChecks: [
      { type: 'QUANTITY', message: 'Invoiced 200 TO for PO item 00010, but only 180 TO have been goods-receipted.', withinTolerance: false },
      { type: 'PRICE', message: 'Invoiced unit price SAR 2,141.75 exceeds PO net price SAR 2,050.00 by 4.5% (tolerance 2.0%).', withinTolerance: false },
    ],
  },
  {
    number: '5100012346',
    fiscalYear: '2026',
    companyCode: '1000',
    vendorId: '1000456',
    vendorName: 'Gulf Industrial Supplies',
    gross: SAR(96_200),
    postingDate: '2026-09-20',
    dueDate: '2026-10-20',
    status: 'OPEN',
    paymentBlock: null,
    varianceChecks: [],
  },
  {
    number: '5100012299',
    fiscalYear: '2026',
    companyCode: '1000',
    vendorId: '1000123',
    vendorName: 'ABC Trading LLC',
    gross: SAR(151_000),
    postingDate: '2026-08-12',
    dueDate: '2026-09-26',
    status: 'PAID',
    paymentBlock: null,
    paidOn: '2026-09-26',
    paymentDocument: '1500009876',
  },
  {
    number: '5100099999',
    fiscalYear: '2026',
    companyCode: '3000',
    vendorId: '1000456',
    vendorName: 'Gulf Industrial Supplies',
    gross: SAR(1_250_000),
    status: 'OPEN',
    paymentBlock: null,
  },
  ...SCENARIO_INVOICES,
];

const REQUISITIONS: PurchaseRequisition[] = [
  { number: '1000056789', requester: 'M. Al-Harbi', value: SAR(58_000), status: 'OPEN', createdOn: '2026-09-21', description: 'Spare impellers for pump P-101' },
];

const EQUIPMENT: Equipment[] = [
  { number: '20001234', description: 'Centrifugal pump P-101', functionalLocation: 'RY01-PLT-A-PMP', manufacturer: 'Sulzer', status: 'Installed, in operation', criticality: 'A' },
];

const NOTIFICATIONS: MaintenanceNotification[] = [
  { number: '10004567', type: 'M2', description: 'Abnormal vibration on drive-end bearing', equipment: '20001234', priority: 'High', status: 'Outstanding', reportedOn: '2026-09-22' },
];

const WORK_ORDERS: WorkOrder[] = [
  {
    number: '4001234',
    description: 'Replace drive-end bearing and realign coupling',
    equipment: '20001234',
    orderType: 'PM01',
    priority: 'High',
    status: 'Released',
    plannedStart: '2026-09-30',
    plannedEnd: '2026-10-01',
    plannedCost: SAR(18_400),
  },
];

const HISTORY: Record<string, MaintenanceEvent[]> = {
  '20001234': [
    { date: '2026-01-14', kind: 'WORK_ORDER', reference: '4000871', title: 'Preventive maintenance — quarterly', severity: 'positive' },
    { date: '2026-04-09', kind: 'WORK_ORDER', reference: '4000990', title: 'Preventive maintenance — quarterly', severity: 'positive' },
    { date: '2026-06-02', kind: 'NOTIFICATION', reference: '10004102', title: 'Seal leakage reported', detail: 'Mechanical seal replaced under order 4001050.', severity: 'warning' },
    { date: '2026-07-11', kind: 'MEASUREMENT', reference: 'MP-5521', title: 'Vibration 4.1 mm/s (alert limit 4.5)', severity: 'warning' },
    { date: '2026-09-22', kind: 'NOTIFICATION', reference: '10004567', title: 'Abnormal vibration on drive-end bearing', detail: 'Vibration 7.2 mm/s — above trip limit.', severity: 'critical' },
    { date: '2026-09-30', kind: 'WORK_ORDER', reference: '4001234', title: 'Bearing replacement planned', severity: 'neutral' },
  ],
};

const GL: GLBalance[] = [
  {
    account: '400000',
    description: 'Consumption of raw materials',
    companyCode: '1000',
    fiscalYear: '2026',
    period: '009',
    debit: SAR(8_412_300),
    credit: SAR(122_400),
    balance: SAR(8_289_900),
  },
];

/** Chart of accounts of the scenario company code. */
const GL_ACCOUNTS: GLAccountInfo[] = [
  { account: '200025', name: 'VAT 12%-PURC TAX', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '200040', name: 'RAW MATERIAL', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '200041', name: 'COGS', longName: 'Cost of goods sold', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '220001', name: 'ALINMA INCOMI A/C', longName: 'Alinma bank incoming account', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '220002', name: 'BANK OUTGOING A/C', longName: 'Bank outgoing account (assumed)', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '500030', name: 'GR/IR CLEARING', companyCode: '1030', chartOfAccounts: 'ACGC' },
  { account: '700000', name: 'SALES', companyCode: '1030', chartOfAccounts: 'ACGC' },
];

/** Assumed fixed assets, bank accounts and their state: the walkthrough documents do not cover them. */
const BANK_ACCOUNTS: BankReconciliationAccount[] = [
  { companyCode: '1030', glAccount: '220001', glAccountName: 'ALINMA INCOMI A/C', houseBank: 'ALIN1', houseBankAccount: 'INC01', openItems: 0, openBalance: { amount: 0, currency: 'SAR' } },
  { companyCode: '1030', glAccount: '220002', glAccountName: 'BANK OUTGOING A/C', houseBank: 'ALIN1', houseBankAccount: 'OUT01', openItems: 1, openBalance: { amount: -2_240, currency: 'SAR' } },
];
const DEPRECIATION: Omit<DepreciationOverview, 'fiscalYear'> = {
  companyCode: '1030',
  assets: [
    { asset: '100000000010', description: 'Forklift truck', posted: 9_000, unposted: 3_000, netBookValue: 48_000, currency: 'SAR' },
    { asset: '100000000011', description: 'Warehouse racking', posted: 6_000, unposted: 0, netBookValue: 54_000, currency: 'SAR' },
  ],
  exceptions: [
    { asset: '100000000010', period: '010', status: 'Planned, not yet posted', amount: 1_000, currency: 'SAR' },
    { asset: '100000000010', period: '011', status: 'Planned, not yet posted', amount: 1_000, currency: 'SAR' },
    { asset: '100000000010', period: '012', status: 'Planned, not yet posted', amount: 1_000, currency: 'SAR' },
  ],
  truncated: false,
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const overdueDays = (dueDate: string | undefined, keyDate: string) => (dueDate ? Math.floor((Date.parse(keyDate) - Date.parse(dueDate)) / 86_400_000) : 0);

/** Assumed valuation price per unit of the scenario material, used to value mock goods issues. */
const MOCK_VALUATION_PRICE = 1_000;
/** Assumed sales price per unit of the scenario material (sales order 648: 10 PC for SAR 5,000). */
const MOCK_SALES_PRICE = 500;
/** VAT rate of the scenario tax code V1 and the invoice-verification price tolerance. */
const MOCK_TAX_RATE = 0.12;
const MOCK_PRICE_TOLERANCE = 0.02;
const fmtSar = (amount: number) => `SAR ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Simulated SAP authorizations per user (the SAP system's view, not Prowess roles). */
interface SapAuth {
  companyCodes: string[];
  mayReleaseInvoices: boolean;
  mayReleaseCredit: boolean;
}
const DEFAULT_AUTH: SapAuth = { companyCodes: ['1000', '1030', '2000'], mayReleaseInvoices: false, mayReleaseCredit: false };
const SAP_AUTH: Record<string, SapAuth> = {
  'alex.morgan@prowess.example': { companyCodes: ['1000', '1030', '2000'], mayReleaseInvoices: true, mayReleaseCredit: true },
};

export class MockSapGateway implements SapGateway {
  readonly systemId = 'S4-MOCK';
  readonly mock = true;
  private readonly invoices = structuredClone(INVOICES);
  private readonly notes = new Map<string, string[]>();
  private readonly purchaseOrders = structuredClone(PURCHASE_ORDERS);
  private readonly goodsReceipts = structuredClone(GOODS_RECEIPTS);
  private readonly requisitions = structuredClone(REQUISITIONS);
  // Order-to-cash documents are mutable so the write tools can be exercised end to end.
  private readonly salesOrders = structuredClone(SCENARIO_SALES_ORDERS);
  private readonly deliveries = structuredClone(SCENARIO_DELIVERIES);
  private readonly billing = structuredClone(SCENARIO_BILLING);
  private readonly flows = structuredClone(SCENARIO_FLOWS);
  private readonly journals = structuredClone(SCENARIO_JOURNALS);
  private readonly lineItems = structuredClone(SCENARIO_LINE_ITEMS);
  private readonly stock = structuredClone(SCENARIO_STOCK);
  private readonly credit = structuredClone(SCENARIO_CREDIT);
  private readonly payments: PaymentRequest[] = [];
  private readonly lastNumber = {
    delivery: 80000257,
    goodsIssue: 1000000009,
    billing: 90000181,
    accounting: 1000000019,
    requisition: 1000056789,
    purchaseOrder: 4200000403,
    materialDocument: 7000000461,
    goodsReceiptPosting: 1002001,
    invoice: 5105600002,
    invoicePosting: 2001001,
    salesOrder: 650,
    creditMemoRequest: 60000000,
    incomingPayment: 5000006,
    outgoingPayment: 3000007,
    reversal: 1700000000,
    clearing: 1600000000,
    journal: 100000000,
  };

  constructor(private readonly latencyMs = 150) {}

  private async latency() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs * (0.6 + Math.random() * 0.8)));
  }

  private auth(ctx: SapCallContext): SapAuth {
    return SAP_AUTH[ctx.principal.sub] ?? DEFAULT_AUTH;
  }

  private requireCompanyCode(ctx: SapCallContext, companyCode: string, what: string) {
    if (!this.auth(ctx).companyCodes.includes(companyCode)) {
      throw new SapError('NOT_AUTHORIZED', `SAP denied access: you are not authorized for company code ${companyCode} (${what}).`);
    }
  }

  private find<T>(list: T[], pred: (t: T) => boolean, what: string, id: string): T {
    const hit = list.find(pred);
    if (!hit) throw new SapError('NOT_FOUND', `${what} ${id} was not found in SAP.`);
    return structuredClone(hit);
  }

  async systemInfo(): Promise<SystemInfo> {
    return { systemId: this.systemId, description: 'Prowess mock S/4HANA (fictitious data)', release: 'S/4HANA 2023 FPS02 (simulated)', client: '100', mock: true };
  }

  async getInvoice(ctx: SapCallContext, number: string, fiscalYear?: string): Promise<Invoice> {
    await this.latency();
    const inv = this.find(this.invoices, (i) => i.number === number && (!fiscalYear || i.fiscalYear === fiscalYear), 'Supplier invoice', number);
    this.requireCompanyCode(ctx, inv.companyCode, `invoice ${number}`);
    return inv;
  }

  async getVendor(ctx: SapCallContext, id: string): Promise<Vendor> {
    await this.latency();
    return this.find(VENDORS, (v) => v.id === id.replace(/^V/i, ''), 'Supplier', id);
  }

  async getGLBalance(ctx: SapCallContext, account: string, companyCode: string, fiscalYear: string, period?: string): Promise<GLBalance> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, `G/L account ${account}`);
    const hit = this.find(GL, (g) => g.account === account && g.companyCode === companyCode && g.fiscalYear === fiscalYear, 'G/L account', account);
    return period ? { ...hit, period } : hit;
  }

  async getPurchaseOrder(ctx: SapCallContext, number: string): Promise<PurchaseOrder> {
    await this.latency();
    const po = this.find(this.purchaseOrders, (p) => p.number === number, 'Purchase order', number);
    this.requireCompanyCode(ctx, po.companyCode, `purchase order ${number}`);
    return po;
  }

  async getPurchaseRequisition(_ctx: SapCallContext, number: string): Promise<PurchaseRequisition> {
    await this.latency();
    return this.find(this.requisitions, (p) => p.number === number, 'Purchase requisition', number);
  }

  async getGoodsReceipts(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]> {
    await this.getPurchaseOrder(ctx, purchaseOrder);
    return structuredClone(this.goodsReceipts.filter((g) => g.purchaseOrder === purchaseOrder));
  }

  async getEquipment(_ctx: SapCallContext, number: string): Promise<Equipment> {
    await this.latency();
    return this.find(EQUIPMENT, (e) => e.number === number.replace(/^EQ-?/i, ''), 'Equipment', number);
  }

  async getNotification(_ctx: SapCallContext, number: string): Promise<MaintenanceNotification> {
    await this.latency();
    return this.find(NOTIFICATIONS, (n) => n.number === number, 'Maintenance notification', number);
  }

  async getWorkOrder(_ctx: SapCallContext, number: string): Promise<WorkOrder> {
    await this.latency();
    return this.find(WORK_ORDERS, (w) => w.number === number, 'Maintenance order', number);
  }

  async getMaintenanceHistory(ctx: SapCallContext, equipment: string): Promise<MaintenanceEvent[]> {
    const eq = await this.getEquipment(ctx, equipment);
    return structuredClone(HISTORY[eq.number] ?? []);
  }

  async search(ctx: SapCallContext, query: string): Promise<SearchHit[]> {
    await this.latency();
    const q = query.toLowerCase();
    const allowed = this.auth(ctx).companyCodes;
    const hits: SearchHit[] = [
      ...this.invoices
        .filter((i) => allowed.includes(i.companyCode))
        .map((i) => ({ objectType: 'SupplierInvoice', objectId: i.number, title: `Invoice ${i.number}`, subtitle: `${i.vendorName} · ${i.status}` })),
      ...this.purchaseOrders.map((p) => ({ objectType: 'PurchaseOrder', objectId: p.number, title: `Purchase order ${p.number}`, subtitle: p.vendorName })),
      ...this.salesOrders.map((o) => ({ objectType: 'SalesOrder', objectId: o.number, title: `Sales order ${o.number}`, subtitle: o.soldToName })),
      ...SCENARIO_CUSTOMERS.map((c) => ({ objectType: 'Customer', objectId: c.id, title: c.name, subtitle: `${c.city}, ${c.country}` })),
      ...VENDORS.map((v) => ({ objectType: 'Supplier', objectId: v.id, title: v.name, subtitle: `${v.city}, ${v.country}` })),
      ...EQUIPMENT.map((e) => ({ objectType: 'Equipment', objectId: e.number, title: e.description, subtitle: e.functionalLocation })),
    ];
    return hits.filter((h) => `${h.title} ${h.subtitle ?? ''} ${h.objectId}`.toLowerCase().includes(q)).slice(0, 20);
  }

  async getSalesOrder(_ctx: SapCallContext, number: string): Promise<SalesOrder> {
    await this.latency();
    return this.find(this.salesOrders, (o) => o.number === number, 'Sales order', number);
  }

  async listOpenSalesOrders(_ctx: SapCallContext, salesOrganization?: string): Promise<SalesOrder[]> {
    await this.latency();
    return structuredClone(
      this.salesOrders.filter(
        (o) =>
          (!salesOrganization || o.salesOrganization === salesOrganization) &&
          (o.deliveryStatus !== 'COMPLETE' || o.billingStatus !== 'COMPLETE' || o.creditStatus === 'BLOCKED'),
      ),
    );
  }

  async getSalesOrderFlow(ctx: SapCallContext, number: string): Promise<DocumentFlowStep[]> {
    const order = await this.getSalesOrder(ctx, number);
    return structuredClone(this.flows[order.number] ?? []);
  }

  async getDelivery(_ctx: SapCallContext, number: string): Promise<OutboundDelivery> {
    await this.latency();
    return this.find(this.deliveries, (d) => d.number === number, 'Outbound delivery', number);
  }

  async getBillingDocument(ctx: SapCallContext, number: string): Promise<BillingDocument> {
    await this.latency();
    const doc = this.find(this.billing, (b) => b.number === number, 'Billing document', number);
    this.requireCompanyCode(ctx, doc.companyCode, `billing document ${number}`);
    return doc;
  }

  async getCustomer(_ctx: SapCallContext, id: string): Promise<Customer> {
    await this.latency();
    return this.find(SCENARIO_CUSTOMERS, (c) => c.id === id, 'Customer', id);
  }

  async getCreditProfile(_ctx: SapCallContext, customer: string): Promise<CreditProfile> {
    await this.latency();
    return this.find(this.credit, (c) => c.customer === customer, 'Credit account of customer', customer);
  }

  async listOpenItems(ctx: SapCallContext, query: OpenItemQuery): Promise<OpenItem[]> {
    await this.latency();
    this.requireCompanyCode(ctx, query.companyCode, `${query.accountType.toLowerCase()} line items`);
    return structuredClone(
      this.lineItems.filter(
        (i) =>
          i.accountType === query.accountType &&
          i.companyCode === query.companyCode &&
          (!query.account || i.account === query.account) &&
          (query.status === 'ALL' || (query.status === 'CLEARED') === !!i.clearingDocument) &&
          (!query.dueBy || (i.dueDate ?? i.postingDate) <= query.dueBy),
      ),
    );
  }

  async getAccountingDocument(ctx: SapCallContext, companyCode: string, fiscalYear: string, number: string): Promise<AccountingDocument> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, `accounting document ${number}`);
    return this.find(this.journals, (j) => j.number === number && j.companyCode === companyCode && j.fiscalYear === fiscalYear, 'Accounting document', number);
  }

  async getMaterialStock(_ctx: SapCallContext, material: string, plant?: string): Promise<MaterialStock[]> {
    await this.latency();
    const stock = this.stock.filter((s) => s.material === material && (!plant || s.plant === plant));
    if (!stock.length) throw new SapError('NOT_FOUND', `No stock was found in SAP for material ${material}${plant ? ` in plant ${plant}` : ''}.`);
    return structuredClone(stock);
  }

  async getInfoRecords(_ctx: SapCallContext, material: string, supplier?: string): Promise<InfoRecord[]> {
    await this.latency();
    return structuredClone(SCENARIO_INFO_RECORDS.filter((r) => r.material === material && (!supplier || r.supplier === supplier)));
  }

  async listBlockedInvoices(ctx: SapCallContext, companyCode: string): Promise<Invoice[]> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, 'blocked invoices');
    return structuredClone(this.invoices.filter((i) => i.companyCode === companyCode && i.paymentBlock));
  }

  private nextNumber(kind: keyof MockSapGateway['lastNumber']): string {
    return String(++this.lastNumber[kind]);
  }

  async getInvoicesForPurchaseOrder(ctx: SapCallContext, purchaseOrder: string): Promise<Invoice[]> {
    await this.getPurchaseOrder(ctx, purchaseOrder);
    return structuredClone(this.invoices.filter((i) => i.purchaseOrder === purchaseOrder && i.status !== 'REVERSED'));
  }

  async createPurchaseRequisition(_ctx: SapCallContext, requisition: NewPurchaseRequisition): Promise<PurchaseRequisition> {
    await this.latency();
    const source = SCENARIO_INFO_RECORDS.find((r) => r.material === requisition.material);
    if (!source) throw new SapError('BUSINESS_RULE', `Material ${requisition.material} is not maintained for purchasing in plant ${requisition.plant}.`);
    const created: PurchaseRequisition = {
      number: this.nextNumber('requisition'),
      requester: 'Prowess AI',
      value: { amount: source.netPrice.amount * requisition.quantity, currency: source.netPrice.currency },
      status: 'OPEN',
      createdOn: new Date().toISOString().slice(0, 10),
      description: `${requisition.quantity} x material ${requisition.material} for plant ${requisition.plant}`,
    };
    this.requisitions.push(created);
    return structuredClone(created);
  }

  async createPurchaseOrder(ctx: SapCallContext, order: NewPurchaseOrder): Promise<PurchaseOrder> {
    await this.latency();
    this.requireCompanyCode(ctx, order.companyCode, 'creating a purchase order');
    const vendor = VENDORS.find((v) => v.id === order.supplier);
    if (!vendor) throw new SapError('NOT_FOUND', `Supplier ${order.supplier} was not found in SAP.`);
    if (vendor.postingBlocked) throw new SapError('BUSINESS_RULE', `Supplier ${order.supplier} is blocked for purchasing.`);
    const source = SCENARIO_INFO_RECORDS.find((r) => r.material === order.material && r.supplier === order.supplier);
    const price = order.netPrice ?? source?.netPrice.amount;
    if (price === undefined) throw new SapError('BUSINESS_RULE', `No net price was given and no info record exists for material ${order.material} and supplier ${order.supplier}.`);
    const stock = this.stock.find((r) => r.material === order.material);
    const created: PurchaseOrder = {
      number: this.nextNumber('purchaseOrder'),
      vendorId: vendor.id,
      vendorName: vendor.name,
      value: SAR(price * order.quantity),
      status: 'RELEASED',
      createdOn: new Date().toISOString().slice(0, 10),
      purchasingGroup: order.purchasingGroup,
      companyCode: order.companyCode,
      items: [{ item: '10', material: order.material, description: stock?.description ?? order.material, quantity: order.quantity, unit: stock?.unit ?? 'PC', netPrice: SAR(price), netValue: SAR(price * order.quantity) }],
    };
    this.purchaseOrders.push(created);
    return structuredClone(created);
  }

  async postGoodsReceipt(ctx: SapCallContext, purchaseOrder: string): Promise<GoodsReceipt[]> {
    await this.latency();
    const po = this.purchaseOrders.find((p) => p.number === purchaseOrder);
    if (!po) throw new SapError('NOT_FOUND', `Purchase order ${purchaseOrder} was not found in SAP.`);
    this.requireCompanyCode(ctx, po.companyCode, `purchase order ${purchaseOrder}`);
    if (po.status === 'DRAFT' || po.status === 'AWAITING_APPROVAL') throw new SapError('BUSINESS_RULE', `Purchase order ${purchaseOrder} is not released, so goods cannot be received against it.`);

    const today = new Date().toISOString().slice(0, 10);
    const posted: GoodsReceipt[] = [];
    for (const i of po.items) {
      const received = this.goodsReceipts.filter((g) => g.purchaseOrder === po.number && g.item === i.item).reduce((sum, g) => sum + g.quantity, 0);
      const open = i.quantity - received;
      if (open <= 0) continue;
      posted.push({ materialDocument: '', year: today.slice(0, 4), purchaseOrder: po.number, item: i.item, postingDate: today, quantity: open, unit: i.unit, value: { amount: open * i.netPrice.amount, currency: i.netPrice.currency } });
      const row = this.stock.find((r) => r.material === i.material);
      if (row) row.unrestricted += open;
    }
    if (!posted.length) throw new SapError('BUSINESS_RULE', `Purchase order ${purchaseOrder} is already completely received.`);

    const materialDocument = this.nextNumber('materialDocument');
    for (const g of posted) g.materialDocument = materialDocument;
    this.goodsReceipts.push(...posted);
    po.status = 'DELIVERED';

    const value = posted.reduce((sum, g) => sum + (g.value?.amount ?? 0), 0);
    const document = this.nextNumber('goodsReceiptPosting');
    this.journals.push({
      companyCode: po.companyCode,
      fiscalYear: today.slice(0, 4),
      number: document,
      documentType: 'WE',
      postingDate: today,
      documentDate: today,
      reference: po.number,
      items: [
        { item: '1', account: '200040', description: 'RAW MATERIAL', amount: SAR(value), debitCredit: 'D' },
        { item: '2', account: '500030', description: 'GR/IR Clearing', amount: SAR(-value), debitCredit: 'C' },
      ],
    });
    this.lineItems.push({ companyCode: po.companyCode, fiscalYear: today.slice(0, 4), document, item: '2', documentType: 'WE', accountType: 'GL', account: '500030', accountName: 'GR/IR Clearing', postingDate: today, amount: SAR(-value), assignment: po.number });
    return structuredClone(posted);
  }

  async createSupplierInvoice(ctx: SapCallContext, invoice: NewSupplierInvoice): Promise<Invoice> {
    await this.latency();
    const po = this.purchaseOrders.find((p) => p.number === invoice.purchaseOrder);
    if (!po) throw new SapError('NOT_FOUND', `Purchase order ${invoice.purchaseOrder} was not found in SAP.`);
    this.requireCompanyCode(ctx, po.companyCode, `purchase order ${po.number}`);
    if (this.invoices.some((i) => i.purchaseOrder === po.number && i.status !== 'REVERSED')) {
      throw new SapError('BUSINESS_RULE', `Purchase order ${po.number} has already been invoiced.`);
    }
    if (this.invoices.some((i) => i.vendorId === po.vendorId && i.reference === invoice.reference)) {
      throw new SapError('BUSINESS_RULE', `Supplier ${po.vendorId} already has an invoice with reference ${invoice.reference} (duplicate invoice check).`);
    }

    // Three-way match: the invoice is compared with what was received at the order price.
    const receivedNet = this.goodsReceipts.filter((g) => g.purchaseOrder === po.number).reduce((sum, g) => sum + (g.value?.amount ?? 0), 0);
    const expectedGross = Math.round(receivedNet * (1 + MOCK_TAX_RATE) * 100) / 100;
    const variances: NonNullable<Invoice['varianceChecks']> = [];
    if (receivedNet === 0) {
      variances.push({ type: 'QUANTITY', message: `Invoice received for purchase order ${po.number}, but no goods receipt has been posted.`, withinTolerance: false });
    } else if (Math.abs(invoice.grossAmount - expectedGross) > expectedGross * MOCK_PRICE_TOLERANCE) {
      variances.push({
        type: 'PRICE',
        message: `Invoiced ${fmtSar(invoice.grossAmount)} gross, but the goods received are worth ${fmtSar(expectedGross)} gross (tolerance ${MOCK_PRICE_TOLERANCE * 100}%).`,
        withinTolerance: false,
      });
    }
    const blocked = variances.length > 0;

    const today = new Date().toISOString().slice(0, 10);
    const created: Invoice = {
      number: this.nextNumber('invoice'),
      fiscalYear: today.slice(0, 4),
      companyCode: po.companyCode,
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      gross: SAR(invoice.grossAmount),
      postingDate: today,
      dueDate: today,
      status: blocked ? 'PAYMENT_BLOCKED' : 'OPEN',
      paymentBlock: blocked ? { code: 'R', description: 'Invoice verification' } : null,
      purchaseOrder: po.number,
      varianceChecks: variances,
      reference: invoice.reference,
    };
    this.invoices.push(created);

    const net = Math.round((invoice.grossAmount / (1 + MOCK_TAX_RATE)) * 100) / 100;
    const document = this.nextNumber('invoicePosting');
    this.journals.push({
      companyCode: po.companyCode,
      fiscalYear: created.fiscalYear,
      number: document,
      documentType: 'RE',
      postingDate: today,
      documentDate: invoice.invoiceDate ?? today,
      reference: invoice.reference,
      items: [
        { item: '1', account: po.vendorId, description: po.vendorName, amount: SAR(-invoice.grossAmount), debitCredit: 'C' },
        { item: '2', account: '500030', description: 'GR/IR Clearing', amount: SAR(net), debitCredit: 'D' },
        { item: '3', account: '200025', description: 'VAT 12%-PURC TAX', amount: SAR(Math.round((invoice.grossAmount - net) * 100) / 100), debitCredit: 'D' },
      ],
    });
    this.lineItems.push(
      {
        companyCode: po.companyCode,
        fiscalYear: created.fiscalYear,
        document,
        item: '1',
        documentType: 'RE',
        accountType: 'SUPPLIER',
        account: po.vendorId,
        accountName: po.vendorName,
        postingDate: today,
        dueDate: today,
        amount: SAR(-invoice.grossAmount),
        assignment: invoice.reference,
        ...(blocked && { paymentBlock: 'R' }),
      },
      { companyCode: po.companyCode, fiscalYear: created.fiscalYear, document, item: '2', documentType: 'RE', accountType: 'GL', account: '500030', accountName: 'GR/IR Clearing', postingDate: today, amount: SAR(net), assignment: po.number },
    );
    return structuredClone(created);
  }

  async createDelivery(_ctx: SapCallContext, salesOrder: string): Promise<OutboundDelivery> {
    await this.latency();
    const order = this.salesOrders.find((o) => o.number === salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} was not found in SAP.`);
    if (order.creditStatus === 'BLOCKED') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is blocked by the credit check and cannot be delivered.`);
    if (order.deliveryStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is already completely delivered.`);
    if (this.incompletion.get(salesOrder)?.some((e) => e.blocksDelivery)) throw new SapError('BUSINESS_RULE', `SAP rejected Outbound delivery for sales order ${salesOrder}: Order is incomplete - maintain the order`);
    for (const i of order.items) {
      const available = this.stock.filter((r) => r.material === i.material && (!i.plant || r.plant === i.plant)).reduce((sum, r) => sum + r.unrestricted, 0);
      if (available < i.quantity) {
        throw new SapError('BUSINESS_RULE', `Only ${available} ${i.unit} of material ${i.material} are available; ${i.quantity} ${i.unit} are required.`);
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const delivery: OutboundDelivery = {
      number: this.nextNumber('delivery'),
      shipTo: order.soldTo,
      shipToName: order.soldToName,
      salesOrder: order.number,
      plannedGoodsIssueDate: order.requestedDeliveryDate ?? today,
      goodsIssueStatus: 'NOT_STARTED',
      pickingStatus: 'COMPLETE',
      items: order.items.map((i) => ({ item: i.item, material: i.material, description: i.description, quantity: i.quantity, unit: i.unit, ...(i.plant && { plant: i.plant }) })),
    };
    this.deliveries.push(delivery);
    order.deliveryStatus = 'COMPLETE';
    (this.flows[order.number] ??= []).push({ category: 'DELIVERY', document: delivery.number, date: today, status: 'Goods issue outstanding' });
    return structuredClone(delivery);
  }

  async postGoodsIssue(_ctx: SapCallContext, number: string): Promise<OutboundDelivery> {
    await this.latency();
    const delivery = this.deliveries.find((d) => d.number === number);
    if (!delivery) throw new SapError('NOT_FOUND', `Outbound delivery ${number} was not found in SAP.`);
    if (delivery.goodsIssueStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Goods issue has already been posted for delivery ${number}.`);
    const today = new Date().toISOString().slice(0, 10);
    let cost = 0;
    for (const i of delivery.items) {
      let open = i.quantity;
      for (const row of this.stock.filter((r) => r.material === i.material && (!i.plant || r.plant === i.plant))) {
        const take = Math.min(open, row.unrestricted);
        row.unrestricted -= take;
        open -= take;
      }
      if (open > 0) throw new SapError('BUSINESS_RULE', `Stock of material ${i.material} is not sufficient to post goods issue for delivery ${number}.`);
      cost += i.quantity * MOCK_VALUATION_PRICE;
    }
    delivery.goodsIssueStatus = 'COMPLETE';
    delivery.actualGoodsIssueDate = today;
    const document = this.nextNumber('goodsIssue');
    this.journals.push({
      companyCode: SCENARIO_COMPANY_CODE,
      fiscalYear: today.slice(0, 4),
      number: document,
      documentType: 'WL',
      postingDate: today,
      documentDate: today,
      reference: delivery.number.padStart(10, '0'),
      items: [
        { item: '1', account: '200040', description: 'RAW MATERIAL', amount: SAR(-cost), debitCredit: 'C' },
        { item: '2', account: '200041', description: 'COGS', amount: SAR(cost), debitCredit: 'D' },
      ],
    });
    const flow = (this.flows[delivery.salesOrder ?? ''] ??= []);
    const step = flow.find((f) => f.category === 'DELIVERY' && f.document === delivery.number);
    if (step) step.status = 'Completed';
    flow.push({ category: 'GOODS_ISSUE', document, date: today, status: 'Posted' });
    return structuredClone(delivery);
  }

  async createBillingDocument(ctx: SapCallContext, number: string): Promise<BillingDocument> {
    await this.latency();
    const delivery = this.deliveries.find((d) => d.number === number);
    if (!delivery) throw new SapError('NOT_FOUND', `Outbound delivery ${number} was not found in SAP.`);
    if (delivery.goodsIssueStatus !== 'COMPLETE') throw new SapError('BUSINESS_RULE', `Goods issue has not been posted for delivery ${number}, so it cannot be billed.`);
    const order = this.salesOrders.find((o) => o.number === delivery.salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `The sales order of delivery ${number} was not found in SAP.`);
    if (order.billingStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${order.number} is already completely billed.`);
    this.requireCompanyCode(ctx, SCENARIO_COMPANY_CODE, `billing delivery ${number}`);

    const today = new Date().toISOString().slice(0, 10);
    const fiscalYear = today.slice(0, 4);
    const accountingDocument = this.nextNumber('accounting');
    const doc: BillingDocument = {
      number: this.nextNumber('billing'),
      billingType: 'F2',
      payer: order.soldTo,
      payerName: order.soldToName,
      billingDate: today,
      netValue: order.netValue,
      companyCode: SCENARIO_COMPANY_CODE,
      fiscalYear,
      accountingDocument,
      postedToAccounting: true,
      cancelled: false,
      salesOrder: order.number,
      items: order.items.map((i) => ({ item: i.item, material: i.material, description: i.description, quantity: i.quantity, unit: i.unit, netValue: i.netValue })),
    };
    this.billing.push(doc);
    this.journals.push({
      companyCode: SCENARIO_COMPANY_CODE,
      fiscalYear,
      number: accountingDocument,
      documentType: 'RV',
      postingDate: today,
      documentDate: today,
      reference: doc.number.padStart(10, '0'),
      items: [
        { item: '1', account: order.soldTo, description: order.soldToName, amount: order.netValue, debitCredit: 'D' },
        { item: '2', account: '700000', description: 'Sales', amount: SAR(-order.netValue.amount), debitCredit: 'C' },
      ],
    });
    this.lineItems.push({
      companyCode: SCENARIO_COMPANY_CODE,
      fiscalYear,
      document: accountingDocument,
      item: '1',
      documentType: 'RV',
      accountType: 'CUSTOMER',
      account: order.soldTo,
      accountName: order.soldToName,
      postingDate: today,
      dueDate: today,
      amount: order.netValue,
    });
    order.billingStatus = 'COMPLETE';
    (this.flows[order.number] ??= []).push(
      { category: 'BILLING', document: doc.number, date: today, status: 'Posted to accounting' },
      { category: 'ACCOUNTING', document: accountingDocument, date: today, status: 'Open receivable' },
    );
    return structuredClone(doc);
  }

  /* ---------------- finance analysis ---------------- */

  async searchGLAccounts(_ctx: SapCallContext, searchText: string, companyCode?: string): Promise<GLAccountInfo[]> {
    await this.latency();
    return structuredClone(GL_ACCOUNTS.filter((a) => (!companyCode || a.companyCode === companyCode) && a.name.includes(searchText.toUpperCase())));
  }

  async getAccountActivity(ctx: SapCallContext, companyCode: string, fiscalYear: string, periodFrom = '1', periodTo = '16'): Promise<AccountActivity[]> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, 'G/L account balances');
    const byAccount = new Map<string, AccountActivity>();
    for (const j of this.journals.filter((d) => d.companyCode === companyCode && d.fiscalYear === fiscalYear)) {
      const period = Number(j.postingDate.slice(5, 7));
      if (period < Number(periodFrom) || period > Number(periodTo)) continue;
      // Customer and supplier lines post to reconciliation accounts, which the scenario does not name.
      for (const i of j.items.filter((line) => line.account.length <= 6)) {
        const entry = byAccount.get(i.account) ?? { account: i.account, name: GL_ACCOUNTS.find((a) => a.account === i.account)?.name ?? i.description ?? i.account, debit: 0, credit: 0, net: 0, currency: i.amount.currency };
        if (i.amount.amount >= 0) entry.debit += i.amount.amount;
        else entry.credit -= i.amount.amount;
        entry.net = round2(entry.debit - entry.credit);
        byAccount.set(i.account, entry);
      }
    }
    return [...byAccount.values()].sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
  }

  async getReceivablesAging(ctx: SapCallContext, companyCode: string, currency: string): Promise<ReceivablesAging[]> {
    const today = new Date().toISOString().slice(0, 10);
    const open = await this.listOpenItems(ctx, { accountType: 'CUSTOMER', companyCode, status: 'OPEN' });
    const byCustomer = new Map<string, ReceivablesAging>();
    for (const i of open) {
      const entry = byCustomer.get(i.account) ?? { customer: i.account, total: 0, upTo30: 0, days31to60: 0, days61to90: 0, over90: 0, currency };
      const days = overdueDays(i.dueDate, today);
      entry.total += i.amount.amount;
      entry[days <= 30 ? 'upTo30' : days <= 60 ? 'days31to60' : days <= 90 ? 'days61to90' : 'over90'] += i.amount.amount;
      byCustomer.set(i.account, entry);
    }
    return [...byCustomer.values()].sort((x, y) => y.total - x.total);
  }

  async getPayablesAging(ctx: SapCallContext, companyCode: string, keyDate = new Date().toISOString().slice(0, 10)): Promise<PayablesAging> {
    const open = await this.listOpenItems(ctx, { accountType: 'SUPPLIER', companyCode, status: 'OPEN' });
    const buckets = AGING_BUCKETS.map((bucket) => ({ bucket, amount: 0, items: 0 }));
    const suppliers = new Map<string, PayablesAging['suppliers'][number]>();
    for (const i of open) {
      const amount = -i.amount.amount;
      const days = overdueDays(i.dueDate, keyDate);
      const bucket = buckets[days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4]!;
      bucket.amount += amount;
      bucket.items += 1;
      const supplier = suppliers.get(i.account) ?? { supplier: i.account, ...(i.accountName && { name: i.accountName }), amount: 0, overdue: 0, items: 0 };
      supplier.amount += amount;
      if (days > 0) supplier.overdue += amount;
      supplier.items += 1;
      suppliers.set(i.account, supplier);
    }
    return { companyCode, keyDate, currency: open[0]?.amount.currency ?? 'SAR', buckets, suppliers: [...suppliers.values()].sort((x, y) => y.amount - x.amount), truncated: false };
  }

  async listInvoiceApprovals(ctx: SapCallContext, companyCode: string): Promise<InvoiceApproval[]> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, 'supplier invoices');
    const STATUS: Record<Invoice['status'], string> = { OPEN: 'Posted', PAYMENT_BLOCKED: 'Posted, blocked for payment', PARKED: 'Parked', PAID: 'Paid', REVERSED: 'Reversed' };
    return this.invoices
      .filter((i) => i.companyCode === companyCode && i.status !== 'REVERSED')
      .map((i) => ({
        invoice: i.number,
        fiscalYear: i.fiscalYear,
        supplier: i.vendorId,
        supplierName: i.vendorName,
        gross: i.gross,
        ...(i.postingDate && { postingDate: i.postingDate }),
        status: STATUS[i.status],
        blocked: !!i.paymentBlock,
        ...(i.paymentBlock && { approvalStatus: 'Waiting for release' }),
      }));
  }

  /** Proposal of the next payment run: every open supplier item, with blocked items as exceptions. */
  async getPaymentRunProposal(ctx: SapCallContext, companyCode: string, runId?: string): Promise<PaymentRunProposal> {
    const RUN = 'PRW01';
    if (runId && runId !== RUN) return { runs: [], items: [], exceptions: [] };
    const open = (await this.listOpenItems(ctx, { accountType: 'SUPPLIER', companyCode, status: 'OPEN' })).filter((i) => i.amount.amount < 0);
    const payable = open.filter((i) => !i.paymentBlock);
    const amount = (i: (typeof open)[number]) => ({ amount: -i.amount.amount, currency: i.amount.currency });
    if (!open.length) return { runs: [], items: [], exceptions: [] };
    return {
      runs: [{ runId: RUN, runDate: new Date().toISOString().slice(0, 10), isProposal: true, paymentMethod: 'Bank transfer', amount: { amount: payable.reduce((sum, i) => sum - i.amount.amount, 0), currency: open[0]!.amount.currency } }],
      items: payable.map((i) => ({ runId: RUN, supplier: i.account, ...(i.accountName && { supplierName: i.accountName }), document: i.document, paymentMethod: 'T', amount: amount(i) })),
      exceptions: open
        .filter((i) => i.paymentBlock)
        .map((i) => ({ runId: RUN, supplier: i.account, ...(i.accountName && { supplierName: i.accountName }), document: i.document, blockingReason: i.paymentBlock!, message: 'Item is blocked for payment', amount: amount(i) })),
    };
  }

  async listGRIRCases(ctx: SapCallContext, companyCode: string, fiscalYear?: string): Promise<GRIRCase[]> {
    const open = (await this.listOpenItems(ctx, { accountType: 'GL', account: '500030', companyCode, status: 'OPEN' })).filter((i) => !fiscalYear || i.fiscalYear === fiscalYear);
    const cases: GRIRCase[] = [];
    for (const purchaseOrder of new Set(open.map((i) => i.assignment ?? ''))) {
      const items = open.filter((i) => (i.assignment ?? '') === purchaseOrder);
      const balance = round2(items.reduce((sum, i) => sum + i.amount.amount, 0));
      if (!purchaseOrder || balance === 0) continue;
      const po = this.purchaseOrders.find((p) => p.number === purchaseOrder);
      cases.push({
        purchaseOrder,
        item: '10',
        supplier: po?.vendorId ?? '',
        ...(po && { supplierName: po.vendorName }),
        status: 'New',
        rootCause: balance < 0 ? 'Goods received, invoice missing' : 'Invoice received, goods receipt missing',
        dueDays: overdueDays(items[0]!.postingDate, new Date().toISOString().slice(0, 10)),
        openItems: items.length,
        balance: { amount: balance, currency: items[0]!.amount.currency },
      });
    }
    return cases;
  }

  async listCreditBlockedOrders(_ctx: SapCallContext, customer?: string): Promise<SalesOrder[]> {
    await this.latency();
    return structuredClone(this.salesOrders.filter((o) => o.creditStatus === 'BLOCKED' && (!customer || o.soldTo === customer)));
  }

  async getBankReconciliation(ctx: SapCallContext, companyCode: string): Promise<BankReconciliationAccount[]> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, 'bank reconciliation');
    return structuredClone(BANK_ACCOUNTS.filter((a) => a.companyCode === companyCode));
  }

  async getDepreciationOverview(ctx: SapCallContext, companyCode: string, fiscalYear: string): Promise<DepreciationOverview> {
    await this.latency();
    this.requireCompanyCode(ctx, companyCode, 'fixed assets');
    return companyCode === DEPRECIATION.companyCode ? { ...structuredClone(DEPRECIATION), fiscalYear } : { companyCode, fiscalYear, assets: [], exceptions: [], truncated: false };
  }

  async clearOpenItems(ctx: SapCallContext, request: ClearingRequest): Promise<PostedDocument> {
    await this.latency();
    this.requireCompanyCode(ctx, request.companyCode, 'clearing open items');
    const open = this.lineItems.filter((i) => i.accountType === request.accountType && i.account === request.account && i.companyCode === request.companyCode && !i.clearingDocument);
    const label = `${request.accountType === 'CUSTOMER' ? 'customer' : 'supplier'} ${request.account}`;
    if (!open.length) throw new SapError('BUSINESS_RULE', `There are no open items on the account of ${label} in company code ${request.companyCode}.`);
    const balance = round2(open.reduce((sum, i) => sum + i.amount.amount, 0));
    if (balance !== 0) throw new SapError('BUSINESS_RULE', `The open items of ${label} do not balance: ${fmtSar(balance)} would remain. SAP cannot clear them.`);
    const today = new Date().toISOString().slice(0, 10);
    const document = this.nextNumber('clearing');
    for (const i of open) {
      i.clearingDocument = document;
      i.clearingDate = today;
    }
    return { document, fiscalYear: today.slice(0, 4), companyCode: request.companyCode };
  }

  async postJournalEntry(ctx: SapCallContext, entry: NewJournalEntry): Promise<PostedDocument> {
    await this.latency();
    this.requireCompanyCode(ctx, entry.companyCode, 'posting a journal entry');
    const signed = entry.lines.map((l) => (l.debitCredit === 'D' ? l.amount : -l.amount));
    if (round2(signed.reduce((sum, a) => sum + a, 0)) !== 0) throw new SapError('BUSINESS_RULE', 'Balance in transaction currency: debits and credits of the journal entry are not equal.');
    for (const l of entry.lines) {
      if (!GL_ACCOUNTS.some((a) => a.account === l.glAccount && a.companyCode === entry.companyCode)) throw new SapError('BUSINESS_RULE', `G/L account ${l.glAccount} is not defined in company code ${entry.companyCode}.`);
    }
    const today = entry.postingDate ?? new Date().toISOString().slice(0, 10);
    const document = this.nextNumber('journal');
    this.journals.push({
      companyCode: entry.companyCode,
      fiscalYear: today.slice(0, 4),
      number: document,
      documentType: entry.documentType ?? 'SA',
      postingDate: today,
      documentDate: today,
      ...(entry.headerText && { reference: entry.headerText }),
      items: entry.lines.map((l, index) => ({
        item: String(index + 1),
        account: l.glAccount,
        description: GL_ACCOUNTS.find((a) => a.account === l.glAccount)?.name ?? l.glAccount,
        amount: { amount: signed[index]!, currency: entry.currency },
        debitCredit: l.debitCredit,
        ...(l.costCenter && { costCenter: l.costCenter }),
      })),
    });
    return { document, fiscalYear: today.slice(0, 4), companyCode: entry.companyCode };
  }

  /* ---------------- payments on account (request, second-person approval, posting) ---------------- */

  private payment(ctx: SapCallContext, id: string): PaymentRequest {
    const payment = this.payments.find((p) => p.id === id);
    if (!payment) throw new SapError('NOT_FOUND', `Payment request ${id} was not found in SAP.`);
    this.requireCompanyCode(ctx, payment.companyCode, 'payment requests');
    return payment;
  }

  async listPaymentRequests(ctx: SapCallContext, query: PaymentRequestQuery): Promise<PaymentRequest[]> {
    await this.latency();
    if (query.companyCode) this.requireCompanyCode(ctx, query.companyCode, 'payment requests');
    const allowed = this.auth(ctx).companyCodes;
    return structuredClone(
      this.payments
        .filter((p) => allowed.includes(p.companyCode) && (!query.companyCode || p.companyCode === query.companyCode) && (!query.status || p.status === query.status))
        .reverse(),
    );
  }

  async getPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    await this.latency();
    return structuredClone(this.payment(ctx, id));
  }

  async createPaymentRequest(ctx: SapCallContext, request: NewPaymentRequest): Promise<PaymentRequest> {
    await this.latency();
    this.requireCompanyCode(ctx, request.companyCode, 'payment requests');
    const partnerName = request.direction === 'INCOMING' ? SCENARIO_CUSTOMERS.find((c) => c.id === request.partner)?.name : VENDORS.find((v) => v.id === request.partner)?.name;
    if (!partnerName) throw new SapError('NOT_FOUND', `${request.direction === 'INCOMING' ? 'Customer' : 'Supplier'} ${request.partner} was not found in SAP.`);
    const created: PaymentRequest = {
      id: randomUUID(),
      direction: request.direction,
      companyCode: request.companyCode,
      partner: request.partner,
      partnerName,
      bankAccount: request.bankAccount,
      amount: { amount: request.amount, currency: request.currency },
      status: 'NEW',
      ...(request.reference && { reference: request.reference }),
      ...(request.text && { text: request.text }),
      createdBy: ctx.principal.sub,
      createdOn: new Date().toISOString().slice(0, 10),
    };
    this.payments.push(created);
    return structuredClone(created);
  }

  async approvePaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    await this.latency();
    const payment = this.payment(ctx, id);
    if (payment.status !== 'NEW') throw new SapError('BUSINESS_RULE', `Payment request ${id} is ${payment.status.toLowerCase()} and can no longer be approved.`);
    if (payment.createdBy === ctx.principal.sub) throw new SapError('BUSINESS_RULE', 'You created this payment request, so a second person must approve it.');
    payment.status = 'APPROVED';
    payment.approvedBy = ctx.principal.sub;
    return structuredClone(payment);
  }

  async rejectPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    await this.latency();
    const payment = this.payment(ctx, id);
    if (payment.status !== 'NEW' && payment.status !== 'APPROVED') throw new SapError('BUSINESS_RULE', `Payment request ${id} is ${payment.status.toLowerCase()} and can no longer be rejected.`);
    payment.status = 'REJECTED';
    return structuredClone(payment);
  }

  async postPaymentRequest(ctx: SapCallContext, id: string): Promise<PaymentRequest> {
    await this.latency();
    const payment = this.payment(ctx, id);
    if (payment.status !== 'APPROVED') throw new SapError('BUSINESS_RULE', `Payment request ${id} is ${payment.status.toLowerCase()}; only an approved request can be posted.`);
    const incoming = payment.direction === 'INCOMING';
    const today = new Date().toISOString().slice(0, 10);
    const document = this.nextNumber(incoming ? 'incomingPayment' : 'outgoingPayment');
    const { amount, currency } = payment.amount;
    // Incoming: debit bank, credit customer. Outgoing: debit supplier, credit bank.
    const partnerAmount = incoming ? -amount : amount;
    this.journals.push({
      companyCode: payment.companyCode,
      fiscalYear: today.slice(0, 4),
      number: document,
      documentType: incoming ? 'DZ' : 'KZ',
      postingDate: today,
      documentDate: today,
      ...(payment.reference && { reference: payment.reference }),
      items: [
        { item: '1', account: payment.bankAccount, description: 'Bank account', amount: { amount: -partnerAmount, currency }, debitCredit: incoming ? 'D' : 'C' },
        { item: '2', account: payment.partner, ...(payment.partnerName && { description: payment.partnerName }), amount: { amount: partnerAmount, currency }, debitCredit: incoming ? 'C' : 'D' },
      ],
    });
    // A payment on account: the item stays open on the partner account until it is cleared against invoices.
    this.lineItems.push({
      companyCode: payment.companyCode,
      fiscalYear: today.slice(0, 4),
      document,
      item: '2',
      documentType: incoming ? 'DZ' : 'KZ',
      accountType: incoming ? 'CUSTOMER' : 'SUPPLIER',
      account: payment.partner,
      ...(payment.partnerName && { accountName: payment.partnerName }),
      postingDate: today,
      dueDate: today,
      amount: { amount: partnerAmount, currency },
      ...(payment.text && { text: payment.text }),
    });
    payment.status = 'POSTED';
    payment.accountingDocument = document;
    payment.fiscalYear = today.slice(0, 4);
    return structuredClone(payment);
  }

  /* ---------------- sales order entry, credit release, credit memo request ---------------- */

  async simulateSalesOrder(_ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrderSimulation> {
    await this.latency();
    const customer = SCENARIO_CUSTOMERS.find((c) => c.id === order.soldTo);
    if (!customer) throw new SapError('NOT_FOUND', `Customer ${order.soldTo} was not found in SAP.`);
    if (customer.orderBlocked) throw new SapError('BUSINESS_RULE', `Customer ${order.soldTo} is blocked for sales orders.`);
    const rows = this.stock.filter((r) => r.material === order.material);
    if (!rows.length) throw new SapError('BUSINESS_RULE', `Material ${order.material} is not maintained for sales organization ${order.salesOrganization}.`);
    const available = rows.reduce((sum, r) => sum + r.unrestricted, 0);
    const net = order.quantity * MOCK_SALES_PRICE;
    const credit = this.credit.find((c) => c.customer === order.soldTo);
    return {
      soldTo: customer.id,
      soldToName: customer.name,
      netValue: SAR(net),
      taxAmount: SAR(Math.round(net * MOCK_TAX_RATE * 100) / 100),
      creditStatus: !credit ? 'NOT_CHECKED' : credit.exposure.amount + net > credit.limit.amount ? 'BLOCKED' : 'APPROVED',
      items: [{ material: order.material, description: rows[0]!.description ?? order.material, quantity: order.quantity, unit: rows[0]!.unit, netValue: SAR(net), confirmedQuantity: Math.min(order.quantity, available) }],
    };
  }

  async createSalesOrder(ctx: SapCallContext, order: NewSalesOrder): Promise<SalesOrder> {
    const sim = await this.simulateSalesOrder(ctx, order);
    const today = new Date().toISOString().slice(0, 10);
    const created: SalesOrder = {
      number: this.nextNumber('salesOrder'),
      orderType: order.orderType ?? 'OR',
      salesOrganization: order.salesOrganization,
      distributionChannel: order.distributionChannel,
      division: order.division,
      soldTo: sim.soldTo,
      soldToName: sim.soldToName,
      ...(order.customerReference && { customerReference: order.customerReference }),
      netValue: sim.netValue,
      createdOn: today,
      requestedDeliveryDate: order.requestedDeliveryDate ?? today,
      deliveryStatus: 'NOT_STARTED',
      billingStatus: 'NOT_STARTED',
      creditStatus: sim.creditStatus,
      items: sim.items.map((i) => ({ item: '10', material: i.material, description: i.description, quantity: i.quantity, unit: i.unit, netValue: i.netValue, plant: SCENARIO_COMPANY_CODE })),
    };
    this.salesOrders.push(created);
    this.flows[created.number] = [];
    const credit = this.credit.find((c) => c.customer === created.soldTo);
    if (credit) credit.exposure = SAR(credit.exposure.amount + created.netValue.amount);
    return structuredClone(created);
  }

  async setSalesOrderItemPrice(_ctx: SapCallContext, salesOrder: string, item: string, price: number, currency: string, _conditionType?: string): Promise<SalesOrder> {
    await this.latency();
    const order = this.salesOrders.find((o) => o.number === salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} was not found in SAP.`);
    const line = order.items.find((i) => i.item.replace(/^0+/, '') === item.replace(/^0+/, ''));
    if (!line) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} has no item ${item}.`);
    if (order.billingStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is already billed; its prices can no longer be changed.`);
    line.netValue = { amount: Math.round(price * line.quantity * 100) / 100, currency };
    order.netValue = { amount: order.items.reduce((sum, i) => sum + i.netValue.amount, 0), currency };
    return structuredClone(order);
  }

  /** Incompletion logs by sales document; empty unless a test fills them. */
  readonly incompletion = new Map<string, IncompletionEntry[]>();

  async getIncompletionLog(_ctx: SapCallContext, salesDocument: string): Promise<IncompletionEntry[]> {
    await this.latency();
    return structuredClone(this.incompletion.get(salesDocument) ?? []);
  }

  async setSalesOrderItemWeight(_ctx: SapCallContext, salesOrder: string, item: string, grossWeight: number, netWeight: number, weightUnit: string): Promise<SalesOrder> {
    await this.latency();
    const order = this.salesOrders.find((o) => o.number === salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} was not found in SAP.`);
    const line = order.items.find((i) => i.item.replace(/^0+/, '') === item.replace(/^0+/, ''));
    if (!line) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} has no item ${item}.`);
    if (order.deliveryStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is already delivered; its weights can no longer be changed.`);
    if (netWeight > grossWeight) throw new SapError('BUSINESS_RULE', 'The net weight cannot be more than the gross weight.');
    Object.assign(line, { grossWeight, netWeight, weightUnit });
    const log = this.incompletion.get(salesOrder);
    if (log) this.incompletion.set(salesOrder, log.filter((e) => !(['BRGEW', 'NTGEW', 'GEWEI'].includes(e.fieldName) && e.item === line.item.replace(/^0+/, ''))));
    return structuredClone(order);
  }

  async updateSalesOrder(_ctx: SapCallContext, salesOrder: string, change: SalesOrderChange): Promise<SalesOrder> {
    await this.latency();
    const order = this.salesOrders.find((o) => o.number === salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} was not found in SAP.`);
    if (order.deliveryStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is already delivered; its header data can no longer be changed.`);
    if (change.customerReference) order.customerReference = change.customerReference;
    if (change.paymentTerms) order.paymentTerms = change.paymentTerms;
    if (change.incoterms) order.incoterms = change.incoterms;
    if (change.requestedDeliveryDate) order.requestedDeliveryDate = change.requestedDeliveryDate;
    if (change.shippingPoint) for (const i of order.items) i.shippingPoint = change.shippingPoint;
    if (change.storageLocation) for (const i of order.items) i.storageLocation = change.storageLocation;
    const filled = new Set([...(change.customerReference ? ['BSTKD'] : []), ...(change.shippingPoint ? ['VSTEL'] : []), ...(change.storageLocation ? ['LGORT'] : [])]);
    const log = this.incompletion.get(salesOrder);
    if (log) this.incompletion.set(salesOrder, log.filter((e) => !filled.has(e.fieldName)));
    return structuredClone(order);
  }

  async releaseCreditBlock(ctx: SapCallContext, salesOrder: string): Promise<SalesOrder> {
    await this.latency();
    const order = this.salesOrders.find((o) => o.number === salesOrder);
    if (!order) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} was not found in SAP.`);
    if (order.creditStatus !== 'BLOCKED') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is not blocked by the credit check.`);
    if (!this.auth(ctx).mayReleaseCredit) throw new SapError('NOT_AUTHORIZED', 'SAP denied the release: you lack authorization to release credit-blocked sales documents.');
    order.creditStatus = 'APPROVED';
    return structuredClone(order);
  }

  async createCreditMemoRequest(ctx: SapCallContext, billingDocument: string, reason: string): Promise<CreditMemoRequest> {
    const doc = await this.getBillingDocument(ctx, billingDocument);
    if (doc.cancelled) throw new SapError('BUSINESS_RULE', `Billing document ${billingDocument} is cancelled, so no credit memo can be requested for it.`);
    return { number: this.nextNumber('creditMemoRequest'), billingDocument: doc.number, soldTo: doc.payer, soldToName: doc.payerName, netValue: doc.netValue, reason };
  }

  /* ---------------- reversals ---------------- */

  async reverseGoodsReceipt(ctx: SapCallContext, materialDocument: string, year: string): Promise<Reversal> {
    await this.latency();
    const receipts = this.goodsReceipts.filter((g) => g.materialDocument === materialDocument && g.year === year);
    const po = this.purchaseOrders.find((p) => p.number === receipts[0]?.purchaseOrder);
    if (!receipts.length || !po) throw new SapError('NOT_FOUND', `Material document ${materialDocument}/${year} was not found in SAP.`);
    this.requireCompanyCode(ctx, po.companyCode, `material document ${materialDocument}`);
    if (this.invoices.some((i) => i.purchaseOrder === po.number && i.status !== 'REVERSED')) {
      throw new SapError('BUSINESS_RULE', `Purchase order ${po.number} has already been invoiced. Reverse the supplier invoice before the goods receipt.`);
    }
    for (const g of receipts) {
      const row = this.stock.find((r) => r.material === po.items.find((i) => i.item === g.item)?.material);
      if (row && row.unrestricted < g.quantity) throw new SapError('BUSINESS_RULE', `Only ${row.unrestricted} ${row.unit} are in stock, so the receipt of ${g.quantity} ${g.unit} cannot be reversed.`);
    }
    for (const g of receipts) {
      const row = this.stock.find((r) => r.material === po.items.find((i) => i.item === g.item)?.material);
      if (row) row.unrestricted -= g.quantity;
      this.goodsReceipts.splice(this.goodsReceipts.indexOf(g), 1);
    }
    po.status = this.goodsReceipts.some((g) => g.purchaseOrder === po.number) ? 'PARTIALLY_DELIVERED' : 'RELEASED';
    const value = receipts.reduce((sum, g) => sum + (g.value?.amount ?? 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    this.lineItems.push({ companyCode: po.companyCode, fiscalYear: today.slice(0, 4), document: this.nextNumber('goodsReceiptPosting'), item: '2', documentType: 'WE', accountType: 'GL', account: '500030', accountName: 'GR/IR Clearing', postingDate: today, amount: SAR(value), assignment: po.number });
    return { document: this.nextNumber('materialDocument'), year: today.slice(0, 4), reversedDocument: materialDocument };
  }

  async reverseSupplierInvoice(ctx: SapCallContext, number: string, fiscalYear: string, _reason: string): Promise<Reversal> {
    await this.latency();
    const inv = this.invoices.find((i) => i.number === number && i.fiscalYear === fiscalYear);
    if (!inv) throw new SapError('NOT_FOUND', `Supplier invoice ${number}/${fiscalYear} was not found in SAP.`);
    this.requireCompanyCode(ctx, inv.companyCode, `invoice ${number}`);
    if (inv.status === 'REVERSED') throw new SapError('BUSINESS_RULE', `Supplier invoice ${number} is already reversed.`);
    if (inv.status === 'PAID') throw new SapError('BUSINESS_RULE', `Supplier invoice ${number} is already paid. Reset the payment clearing before reversing it.`);
    const today = new Date().toISOString().slice(0, 10);
    const reversal = this.nextNumber('invoice');
    const posting = this.nextNumber('invoicePosting');
    // The payable and its reversal clear each other; the GR/IR account is debited back.
    const payable = this.lineItems.find((i) => i.accountType === 'SUPPLIER' && i.account === inv.vendorId && !i.clearingDocument && i.amount.amount === -inv.gross.amount);
    if (payable) {
      payable.clearingDocument = posting;
      payable.clearingDate = today;
      delete payable.paymentBlock;
      this.lineItems.push({ ...structuredClone(payable), document: posting, postingDate: today, dueDate: today, amount: SAR(inv.gross.amount) });
    }
    if (inv.purchaseOrder) {
      const net = Math.round((inv.gross.amount / (1 + MOCK_TAX_RATE)) * 100) / 100;
      this.lineItems.push({ companyCode: inv.companyCode, fiscalYear: today.slice(0, 4), document: posting, item: '2', documentType: 'RE', accountType: 'GL', account: '500030', accountName: 'GR/IR Clearing', postingDate: today, amount: SAR(-net), assignment: inv.purchaseOrder });
    }
    inv.status = 'REVERSED';
    inv.paymentBlock = null;
    return { document: reversal, year: today.slice(0, 4), reversedDocument: number };
  }

  async reverseGoodsIssue(_ctx: SapCallContext, number: string): Promise<OutboundDelivery> {
    await this.latency();
    const delivery = this.deliveries.find((d) => d.number === number);
    if (!delivery) throw new SapError('NOT_FOUND', `Outbound delivery ${number} was not found in SAP.`);
    if (delivery.goodsIssueStatus !== 'COMPLETE') throw new SapError('BUSINESS_RULE', `No goods issue has been posted for delivery ${number}.`);
    const flow = (this.flows[delivery.salesOrder ?? ''] ??= []);
    if (flow.some((f) => f.category === 'BILLING')) throw new SapError('BUSINESS_RULE', `Delivery ${number} is already billed. Cancel the billing document before reversing the goods issue.`);
    for (const i of delivery.items) {
      const row = this.stock.find((r) => r.material === i.material && (!i.plant || r.plant === i.plant));
      if (row) row.unrestricted += i.quantity;
    }
    delivery.goodsIssueStatus = 'NOT_STARTED';
    delete delivery.actualGoodsIssueDate;
    const issue = flow.findIndex((f) => f.category === 'GOODS_ISSUE');
    if (issue >= 0) flow.splice(issue, 1);
    const step = flow.find((f) => f.category === 'DELIVERY' && f.document === delivery.number);
    if (step) step.status = 'Goods issue outstanding';
    return structuredClone(delivery);
  }

  async cancelBillingDocument(ctx: SapCallContext, number: string): Promise<Reversal> {
    await this.latency();
    const doc = this.billing.find((b) => b.number === number);
    if (!doc) throw new SapError('NOT_FOUND', `Billing document ${number} was not found in SAP.`);
    this.requireCompanyCode(ctx, doc.companyCode, `billing document ${number}`);
    if (doc.cancelled) throw new SapError('BUSINESS_RULE', `Billing document ${number} is already cancelled.`);
    const receivable = this.lineItems.find((i) => i.accountType === 'CUSTOMER' && i.document === doc.accountingDocument);
    if (receivable?.clearingDocument) throw new SapError('BUSINESS_RULE', `The invoice of billing document ${number} is already paid (clearing document ${receivable.clearingDocument}). Reset the clearing before cancelling it.`);
    const today = new Date().toISOString().slice(0, 10);
    const cancellation = this.nextNumber('billing');
    const posting = this.nextNumber('accounting');
    if (receivable) {
      receivable.clearingDocument = posting;
      receivable.clearingDate = today;
      this.lineItems.push({ ...structuredClone(receivable), document: posting, postingDate: today, dueDate: today, amount: SAR(-receivable.amount.amount) });
    }
    doc.cancelled = true;
    const order = this.salesOrders.find((o) => o.number === doc.salesOrder);
    if (order) {
      order.billingStatus = 'NOT_STARTED';
      this.flows[order.number] = (this.flows[order.number] ?? []).filter((f) => f.category !== 'BILLING' && f.category !== 'ACCOUNTING');
    }
    return { document: cancellation, year: today.slice(0, 4), reversedDocument: number };
  }

  async releaseInvoiceBlock(ctx: SapCallContext, number: string, fiscalYear: string): Promise<Invoice> {
    await this.latency();
    const inv = this.invoices.find((i) => i.number === number && i.fiscalYear === fiscalYear);
    if (!inv) throw new SapError('NOT_FOUND', `Supplier invoice ${number}/${fiscalYear} was not found in SAP.`);
    this.requireCompanyCode(ctx, inv.companyCode, `invoice ${number}`);
    if (!this.auth(ctx).mayReleaseInvoices) {
      throw new SapError('NOT_AUTHORIZED', 'SAP denied the release: you lack authorization to release blocked invoices (MRBR).');
    }
    if (!inv.paymentBlock) throw new SapError('BUSINESS_RULE', `Invoice ${number} has no payment block to release.`);
    inv.paymentBlock = null;
    inv.status = 'OPEN';
    return structuredClone(inv);
  }

  async addInvoiceNote(ctx: SapCallContext, number: string, fiscalYear: string, note: string): Promise<{ noteId: string }> {
    await this.getInvoice(ctx, number, fiscalYear);
    const key = `${number}/${fiscalYear}`;
    this.notes.set(key, [...(this.notes.get(key) ?? []), note]);
    return { noteId: randomUUID() };
  }
}
