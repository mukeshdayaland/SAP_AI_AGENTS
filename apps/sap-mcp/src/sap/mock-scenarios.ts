import type {
  AccountingDocument,
  BillingDocument,
  CreditProfile,
  Customer,
  DocumentFlowStep,
  GoodsReceipt,
  InfoRecord,
  Invoice,
  MaterialStock,
  OpenItem,
  OutboundDelivery,
  PurchaseOrder,
  SalesOrder,
  Vendor,
} from './model.js';

/**
 * Mock data for the two reference scenarios in company code 1030 (currency SAR):
 *
 *  - FI-SD order-to-cash:   sales order 648 → delivery 80000257 → billing 90000181
 *                           → FI document 1000000001 → incoming payment 5000006
 *  - FI-MM purchase-to-pay: PO 4200000402 → goods receipt (FI 1002001)
 *                           → invoice (FI 2001001) → outgoing payment 3000007
 *
 * Document numbers, partners, the material and the G/L accounts follow the
 * walkthrough documents. Values those documents do not show are placeholders
 * and are marked `assumed` below; all of it is served flagged `mock: true`.
 */

const SAR = (amount: number) => ({ amount, currency: 'SAR' });
const CC = '1030';
const FY = '2026';
const MATERIAL = { material: '5496', description: 'RAW MATERIAL:ACGC', unit: 'PC' };

export const SCENARIO_COMPANY_CODE = CC;

export const SCENARIO_CUSTOMERS: Customer[] = [
  { id: '7000000010', name: 'Local Customer-01', country: 'SA', city: 'Al jeddah', orderBlocked: false, deliveryBlocked: false, billingBlocked: false, postingBlocked: false },
  // assumed: a second customer so credit blocks and overdue items can be demonstrated
  { id: '7000000011', name: 'Local Customer-02', country: 'SA', city: 'Riyadh', orderBlocked: false, deliveryBlocked: false, billingBlocked: false, postingBlocked: false },
];

export const SCENARIO_VENDORS: Vendor[] = [
  {
    id: '7002200010',
    name: 'AL-QASSIM',
    country: 'SA',
    city: 'Riyadh',
    paymentTerms: '0001',
    postingBlocked: false,
    paymentBlocked: false,
    openItems: SAR(1_120),
    overdueItems: SAR(1_120),
    riskRating: 'LOW',
  },
];

// assumed: sales area 1030/10/00 — the walkthrough does not show it
const SALES_AREA = { salesOrganization: '1030', distributionChannel: '10', division: '00' };

export const SCENARIO_SALES_ORDERS: SalesOrder[] = [
  {
    number: '648',
    orderType: 'OR',
    ...SALES_AREA,
    soldTo: '7000000010',
    soldToName: 'Local Customer-01',
    customerReference: 'TEST',
    netValue: SAR(5_000),
    createdOn: '2026-09-26',
    requestedDeliveryDate: '2026-10-03',
    paymentTerms: '0001',
    incoterms: 'CIF',
    deliveryStatus: 'COMPLETE',
    billingStatus: 'COMPLETE',
    creditStatus: 'APPROVED',
    items: [{ item: '10', ...MATERIAL, quantity: 10, netValue: SAR(5_000), plant: '1030' }],
  },
  // assumed: open orders for the monitoring and credit use cases
  {
    number: '649',
    orderType: 'OR',
    ...SALES_AREA,
    soldTo: '7000000010',
    soldToName: 'Local Customer-01',
    customerReference: 'PO-2291',
    netValue: SAR(12_500),
    createdOn: '2026-09-29',
    requestedDeliveryDate: '2026-10-05',
    paymentTerms: '0001',
    incoterms: 'CIF',
    deliveryStatus: 'NOT_STARTED',
    billingStatus: 'NOT_STARTED',
    creditStatus: 'APPROVED',
    items: [{ item: '10', ...MATERIAL, quantity: 25, netValue: SAR(12_500), plant: '1030' }],
  },
  {
    number: '650',
    orderType: 'OR',
    ...SALES_AREA,
    soldTo: '7000000011',
    soldToName: 'Local Customer-02',
    netValue: SAR(140_000),
    createdOn: '2026-09-30',
    requestedDeliveryDate: '2026-10-08',
    paymentTerms: '0001',
    incoterms: 'CIF',
    deliveryStatus: 'NOT_STARTED',
    billingStatus: 'NOT_STARTED',
    creditStatus: 'BLOCKED',
    items: [{ item: '10', ...MATERIAL, quantity: 280, netValue: SAR(140_000), plant: '1030' }],
  },
];

export const SCENARIO_FLOWS: Record<string, DocumentFlowStep[]> = {
  '648': [
    { category: 'DELIVERY', document: '80000257', date: '2026-09-26', status: 'Completed' },
    { category: 'GOODS_ISSUE', document: '1000000000', date: '2026-09-26', status: 'Posted' },
    { category: 'BILLING', document: '90000181', date: '2026-09-26', status: 'Posted to accounting' },
    { category: 'ACCOUNTING', document: '1000000001', date: '2026-09-26', status: 'Cleared by payment 5000006' },
  ],
  '649': [],
  '650': [],
};

export const SCENARIO_DELIVERIES: OutboundDelivery[] = [
  {
    number: '80000257',
    shipTo: '7000000010',
    shipToName: 'Local Customer-01',
    salesOrder: '648',
    plannedGoodsIssueDate: '2026-10-03',
    actualGoodsIssueDate: '2026-09-26',
    goodsIssueStatus: 'COMPLETE',
    pickingStatus: 'COMPLETE',
    items: [{ item: '10', ...MATERIAL, quantity: 10, plant: '1030' }],
  },
];

export const SCENARIO_BILLING: BillingDocument[] = [
  {
    number: '90000181',
    billingType: 'F2',
    payer: '7000000010',
    payerName: 'Local Customer-01',
    billingDate: '2026-09-26',
    netValue: SAR(5_000),
    companyCode: CC,
    fiscalYear: FY,
    accountingDocument: '1000000001',
    postedToAccounting: true,
    cancelled: false,
    salesOrder: '648',
    items: [{ item: '10', ...MATERIAL, quantity: 10, netValue: SAR(5_000) }],
  },
];

const journal = (
  number: string,
  documentType: string,
  postingDate: string,
  reference: string | undefined,
  items: [account: string, description: string, amount: number, profitCenter?: string, costCenter?: string][],
): AccountingDocument => ({
  companyCode: CC,
  fiscalYear: FY,
  number,
  documentType,
  postingDate,
  documentDate: postingDate,
  ...(reference && { reference }),
  items: items.map(([account, description, amount, profitCenter, costCenter], i) => ({
    item: String(i + 1),
    account,
    description,
    amount: SAR(amount),
    debitCredit: amount >= 0 ? 'D' : 'C',
    ...(profitCenter && { profitCenter }),
    ...(costCenter && { costCenter }),
  })),
});

export const SCENARIO_JOURNALS: AccountingDocument[] = [
  // Order-to-cash
  journal('1000000000', 'WL', '2026-09-26', '0080000257', [
    ['200040', 'RAW MATERIAL', -10_000, '100005'],
    ['200041', 'COGS', 10_000, '100005'],
  ]),
  journal('1000000001', 'RV', '2026-09-26', '0090000181', [
    ['7000000010', 'Local Customer-01', 5_000],
    ['700000', 'Sales', -5_000, '100005'],
  ]),
  journal('5000006', 'DZ', '2026-09-28', 'TEST', [
    ['220001', 'ALINMA Incomi a/c', 5_000],
    ['7000000010', 'Local Customer-01', -5_000],
  ]),
  // Purchase-to-pay
  journal('1002001', 'WE', '2026-09-27', undefined, [
    ['200040', 'RAW MATERIAL', 2_000, '100000', '10000'],
    ['500030', 'GR/IR Clearing', -2_000, '100000', '10000'],
  ]),
  journal('2001001', 'RE', '2026-09-27', 'VEN003', [
    ['7002200010', 'AL-QASSIM', -2_240],
    ['500030', 'GR/IR Clearing', 2_000, '100000', '10000'],
    ['200025', 'VAT 12%-PURC TAX', 240],
  ]),
  // assumed: the bank account of the outgoing payment is not shown in the walkthrough
  journal('3000007', 'KZ', '2026-09-28', undefined, [
    ['7002200010', 'AL-QASSIM', 2_240],
    ['220002', 'Bank outgoing a/c (assumed)', -2_240],
  ]),
];

const item = (
  accountType: OpenItem['accountType'],
  account: string,
  accountName: string,
  document: string,
  documentType: string,
  postingDate: string,
  amount: number,
  extra: Partial<OpenItem> = {},
): OpenItem => ({
  companyCode: CC,
  fiscalYear: FY,
  document,
  item: '1',
  documentType,
  accountType,
  account,
  accountName,
  postingDate,
  // payment terms 0001: due immediately; G/L items carry no due date
  ...(accountType !== 'GL' && { dueDate: postingDate }),
  amount: SAR(amount),
  ...extra,
});

export const SCENARIO_LINE_ITEMS: OpenItem[] = [
  // Customer 7000000010 (FBL5N)
  item('CUSTOMER', '7000000010', 'Local Customer-01', '2000016', 'DR', '2026-09-22', 2_500, { text: 'test' }),
  item('CUSTOMER', '7000000010', 'Local Customer-01', '1000000001', 'RV', '2026-09-26', 5_000, { clearingDocument: '5000006', clearingDate: '2026-09-28' }),
  item('CUSTOMER', '7000000010', 'Local Customer-01', '5000006', 'DZ', '2026-09-28', -5_000, { clearingDocument: '5000006', clearingDate: '2026-09-28' }),
  // assumed: an overdue receivable of the second customer
  item('CUSTOMER', '7000000011', 'Local Customer-02', '1000000002', 'RV', '2026-08-15', 96_000),
  // Supplier 7002200010 (FBL1N)
  item('SUPPLIER', '7002200010', 'AL-QASSIM', '2001000', 'RE', '2026-09-23', -1_120, { assignment: '20260923' }),
  item('SUPPLIER', '7002200010', 'AL-QASSIM', '2001001', 'RE', '2026-09-27', -2_240, { assignment: '20260927', clearingDocument: '3000007', clearingDate: '2026-09-28' }),
  item('SUPPLIER', '7002200010', 'AL-QASSIM', '3000007', 'KZ', '2026-09-28', 2_240, { assignment: '20260928', clearingDocument: '3000007', clearingDate: '2026-09-28' }),
  // GR/IR clearing account 500030: receipts and invoices match, clearing run not yet executed
  item('GL', '500030', 'GR/IR Clearing', '1002000', 'WE', '2026-09-23', -1_000, { assignment: '4200000401' }),
  item('GL', '500030', 'GR/IR Clearing', '2001000', 'RE', '2026-09-23', 1_000, { assignment: '4200000401' }),
  item('GL', '500030', 'GR/IR Clearing', '1002001', 'WE', '2026-09-27', -2_000, { assignment: '4200000402' }),
  item('GL', '500030', 'GR/IR Clearing', '2001001', 'RE', '2026-09-27', 2_000, { assignment: '4200000402' }),
];

export const SCENARIO_CREDIT: CreditProfile[] = [
  // assumed: credit limits and risk classes are not part of the walkthrough
  { customer: '7000000010', customerName: 'Local Customer-01', creditSegment: '0000', limit: SAR(50_000), exposure: SAR(15_000), exposureBasis: 'CREDIT_MANAGEMENT', riskClass: 'B', blocked: false },
  { customer: '7000000011', customerName: 'Local Customer-02', creditSegment: '0000', limit: SAR(100_000), exposure: SAR(236_000), exposureBasis: 'CREDIT_MANAGEMENT', riskClass: 'D', blocked: false },
];

const poItem = (quantity: number) => ({ item: '10', ...MATERIAL, quantity, netPrice: SAR(1_000), netValue: SAR(1_000 * quantity) });

export const SCENARIO_PURCHASE_ORDERS: PurchaseOrder[] = [
  { number: '4200000401', vendorId: '7002200010', vendorName: 'AL-QASSIM', value: SAR(1_000), status: 'DELIVERED', createdOn: '2026-09-23', purchasingGroup: '103', companyCode: CC, items: [poItem(1)] },
  { number: '4200000402', vendorId: '7002200010', vendorName: 'AL-QASSIM', value: SAR(2_000), status: 'DELIVERED', createdOn: '2026-09-27', purchasingGroup: '103', companyCode: CC, items: [poItem(2)] },
];

export const SCENARIO_GOODS_RECEIPTS: GoodsReceipt[] = [
  // assumed: material document numbers
  { materialDocument: '7000000451', year: FY, purchaseOrder: '4200000401', item: '10', postingDate: '2026-09-23', quantity: 1, unit: 'PC', value: SAR(1_000) },
  { materialDocument: '7000000461', year: FY, purchaseOrder: '4200000402', item: '10', postingDate: '2026-09-27', quantity: 2, unit: 'PC', value: SAR(2_000) },
];

export const SCENARIO_INVOICES: Invoice[] = [
  // assumed: logistics invoice numbers (the walkthrough shows the FI documents 2001000 / 2001001)
  {
    number: '5105600001',
    fiscalYear: FY,
    companyCode: CC,
    vendorId: '7002200010',
    vendorName: 'AL-QASSIM',
    gross: SAR(1_120),
    postingDate: '2026-09-23',
    dueDate: '2026-09-23',
    status: 'OPEN',
    paymentBlock: null,
    purchaseOrder: '4200000401',
    varianceChecks: [],
  },
  {
    number: '5105600002',
    fiscalYear: FY,
    companyCode: CC,
    vendorId: '7002200010',
    vendorName: 'AL-QASSIM',
    gross: SAR(2_240),
    postingDate: '2026-09-27',
    dueDate: '2026-09-27',
    status: 'PAID',
    paymentBlock: null,
    purchaseOrder: '4200000402',
    paidOn: '2026-09-28',
    paymentDocument: '3000007',
  },
];

export const SCENARIO_STOCK: MaterialStock[] = [
  // assumed: stock quantities and the storage location
  { material: '5496', description: 'RAW MATERIAL:ACGC', plant: '1030', storageLocation: '1030', unrestricted: 43, qualityInspection: 0, blocked: 0, unit: 'PC' },
];

export const SCENARIO_INFO_RECORDS: InfoRecord[] = [
  // assumed: info record number and delivery time
  { infoRecord: '5300000012', supplier: '7002200010', supplierName: 'AL-QASSIM', material: '5496', purchasingOrganization: '1030', plant: '1030', netPrice: SAR(1_000), plannedDeliveryDays: 3, lastPurchaseOrder: '4200000402' },
];
