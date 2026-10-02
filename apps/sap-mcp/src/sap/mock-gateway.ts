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
  type NewPurchaseOrder,
  type NewPurchaseRequisition,
  type NewSupplierInvoice,
  type OpenItem,
  type OpenItemQuery,
  type OutboundDelivery,
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

/** Assumed valuation price per unit of the scenario material, used to value mock goods issues. */
const MOCK_VALUATION_PRICE = 1_000;
/** VAT rate of the scenario tax code V1 and the invoice-verification price tolerance. */
const MOCK_TAX_RATE = 0.12;
const MOCK_PRICE_TOLERANCE = 0.02;
const fmtSar = (amount: number) => `SAR ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Simulated SAP authorizations per user (the SAP system's view, not Prowess roles). */
interface SapAuth {
  companyCodes: string[];
  mayReleaseInvoices: boolean;
}
const DEFAULT_AUTH: SapAuth = { companyCodes: ['1000', '1030', '2000'], mayReleaseInvoices: false };
const SAP_AUTH: Record<string, SapAuth> = {
  'alex.morgan@prowess.example': { companyCodes: ['1000', '1030', '2000'], mayReleaseInvoices: true },
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
    return this.find(SCENARIO_CREDIT, (c) => c.customer === customer, 'Credit account of customer', customer);
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
