import { z } from 'zod';
import type { PurchaseOrder } from '../sap/model.js';
import { companyCode } from './line-items.js';
import { defineTool, fmt, now, type ToolContext } from './types.js';

const poNumber = z.string().regex(/^\d{10}$/).describe('Purchase order number, e.g. 4500012345');

const quantity = z.coerce.number().positive().max(1_000_000).describe('Quantity in the order unit');
const supplier = z.string().regex(/^[A-Z0-9]{1,10}$/i).describe('SAP supplier / business partner number, e.g. 7002200010');

function purchaseOrderComponent(po: PurchaseOrder) {
  return {
    type: 'purchase_order' as const,
    data: {
      number: po.number,
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      value: po.value,
      status: po.status,
      createdOn: po.createdOn,
      ...(po.purchasingGroup && { purchasingGroup: po.purchasingGroup }),
      items: po.items.map((i) => ({ item: i.item, material: i.material, description: i.description, quantity: i.quantity, unit: i.unit, netValue: i.netValue })),
    },
  };
}

const orderSource = (ctx: ToolContext, number: string) => ({ system: ctx.gateway.systemId, objectType: 'PurchaseOrder', objectId: number, retrievedAt: now(), mock: ctx.gateway.mock });
const quantities = (items: { quantity: number; unit: string; description: string }[]) => items.map((i) => `${i.quantity} ${i.unit} ${i.description}`).join(', ');

/** What is still to be received per item of a purchase order. */
async function openQuantities(ctx: ToolContext, po: PurchaseOrder) {
  const receipts = await ctx.gateway.getGoodsReceipts(ctx.sap, po.number);
  return po.items
    .map((i) => ({ ...i, quantity: i.quantity - receipts.filter((g) => g.item === i.item).reduce((sum, g) => sum + g.quantity, 0) }))
    .filter((i) => i.quantity > 0);
}

const material = z.string().regex(/^[A-Z0-9-]{1,40}$/i).describe('Material number, e.g. 5496');
const plant = z.string().regex(/^[A-Z0-9]{4}$/).describe('Plant, e.g. 1030');

/** MM purchasing and inventory: requisitions, purchase orders (ME21N), goods receipts (MIGO), stock and sources of supply. */
export const mmTools = [
  defineTool({
    name: 'mm_getPurchaseOrder',
    domain: 'mm',
    title: 'Get purchase order',
    description: 'Retrieve a purchase order header, items, value and release status from SAP S/4HANA.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving purchase order',
    input: { purchaseOrderNumber: poNumber },
    async run({ purchaseOrderNumber }, ctx) {
      const po = await ctx.gateway.getPurchaseOrder(ctx.sap, purchaseOrderNumber);
      return {
        data: {
          purchaseOrder: { ...po, value: fmt(po.value), items: po.items.map((i) => `${i.item}: ${i.quantity} ${i.unit} ${i.description} @ ${fmt(i.netPrice)}`) },
          summary: `Purchase order **${po.number}** for **${po.vendorName}** is worth **${fmt(po.value)}** and is **${po.status.replaceAll('_', ' ').toLowerCase()}**.`,
        },
        components: [purchaseOrderComponent(po)],
        source: orderSource(ctx, po.number),
        followUps: [
          { label: 'Goods receipts', prompt: `Show goods receipts for purchase order ${po.number}.` },
          { label: 'Analyze vendor', prompt: `Review vendor ${po.vendorId} exposure.` },
        ],
      };
    },
  }),

  defineTool({
    name: 'mm_getPurchaseOrderFlow',
    domain: 'mm',
    title: 'Get purchase order flow',
    description:
      'Trace a purchase order through purchase-to-pay: goods receipts, supplier invoices and their payment status. Use to find what is outstanding for an order.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Tracing the purchase-to-pay document flow',
    input: { purchaseOrderNumber: poNumber },
    async run({ purchaseOrderNumber }, ctx) {
      const po = await ctx.gateway.getPurchaseOrder(ctx.sap, purchaseOrderNumber);
      const [receipts, invoices] = await Promise.all([ctx.gateway.getGoodsReceipts(ctx.sap, po.number), ctx.gateway.getInvoicesForPurchaseOrder(ctx.sap, po.number)]);
      const open = po.items.filter((i) => receipts.filter((g) => g.item === i.item).reduce((sum, g) => sum + g.quantity, 0) < i.quantity);
      const received = receipts.length > 0 && open.length === 0;
      const blocked = invoices.filter((i) => i.paymentBlock);
      const nextSteps = [
        ...(!received ? [`Post the goods receipt for ${open.length} open item(s) (MIGO).`] : []),
        ...(received && !invoices.length ? ['Enter the supplier invoice (MIRO).'] : []),
        ...blocked.map((i) => `Resolve the payment block on invoice ${i.number} (${i.paymentBlock!.description}).`),
        ...invoices.filter((i) => i.status === 'OPEN').map((i) => `Invoice ${i.number} is open: it will be paid in the next payment run after its due date.`),
      ];
      return {
        data: {
          summary:
            `Purchase order **${po.number}** for **${po.vendorName}** is worth **${fmt(po.value)}**. ` +
            `Goods receipt: ${received ? 'complete' : receipts.length ? 'partial' : 'not started'}; ` +
            `invoices: ${invoices.length ? invoices.map((i) => `${i.number} (${i.status.replaceAll('_', ' ').toLowerCase()})`).join(', ') : 'none'}.`,
          receipts: receipts.map((r) => `${r.materialDocument}: ${r.quantity} ${r.unit} on ${r.postingDate}`),
          invoices: invoices.map((i) => `${i.number}: ${fmt(i.gross)}, ${i.status}`),
          nextSteps,
        },
        components: [
          purchaseOrderComponent(po),
          {
            type: 'timeline',
            data: {
              title: `Document flow · purchase order ${po.number}`,
              events: [
                { date: po.createdOn, title: `Purchase order ${po.number}`, detail: `${po.vendorName} · ${fmt(po.value)}`, tone: 'positive' as const },
                ...receipts.slice(0, 40).map((r) => ({ date: r.postingDate, title: `Goods receipt ${r.materialDocument}`, detail: `${r.quantity} ${r.unit} for item ${r.item}`, tone: 'positive' as const })),
                ...invoices.slice(0, 40).map((i) => ({
                  date: i.postingDate ?? '',
                  title: `Supplier invoice ${i.number}`,
                  detail: `${fmt(i.gross)} · ${i.paymentBlock ? `blocked (${i.paymentBlock.description})` : i.status === 'PAID' ? `paid with ${i.paymentDocument ?? 'a payment document'}` : 'open'}`,
                  tone: i.paymentBlock ? ('critical' as const) : i.status === 'PAID' ? ('positive' as const) : ('neutral' as const),
                })),
              ],
            },
          },
        ],
        source: orderSource(ctx, po.number),
        outputs: {
          purchaseOrder: po.number,
          supplier: po.vendorId,
          companyCode: po.companyCode,
          received: String(received),
          invoiced: String(invoices.length > 0),
          paymentBlocked: String(blocked.length > 0),
        },
      };
    },
  }),

  defineTool({
    name: 'mm_getPurchaseRequisition',
    domain: 'mm',
    title: 'Get purchase requisition',
    description: 'Retrieve a purchase requisition from SAP S/4HANA.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving purchase requisition',
    input: { requisitionNumber: z.string().regex(/^\d{10}$/) },
    async run({ requisitionNumber }, ctx) {
      const pr = await ctx.gateway.getPurchaseRequisition(ctx.sap, requisitionNumber);
      return {
        data: { requisition: { ...pr, value: fmt(pr.value) }, summary: `Requisition **${pr.number}** (${pr.description}) by ${pr.requester}: **${fmt(pr.value)}**, status ${pr.status}.` },
        components: [{ type: 'purchase_requisition', data: pr }],
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseRequisition', objectId: pr.number, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'mm_getGoodsReceipt',
    domain: 'mm',
    title: 'Get goods receipts',
    description: 'List goods receipts (movement type 101) posted against a purchase order.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving goods receipts',
    input: { purchaseOrder: poNumber },
    async run({ purchaseOrder }, ctx) {
      const receipts = await ctx.gateway.getGoodsReceipts(ctx.sap, purchaseOrder);
      const total = receipts.reduce((s, r) => s + r.quantity, 0);
      return {
        data: {
          receipts,
          summary: receipts.length
            ? `${receipts.length} goods receipt(s) posted for PO **${purchaseOrder}**, totalling **${total} ${receipts[0]!.unit}**.`
            : `No goods receipts have been posted for PO **${purchaseOrder}**.`,
        },
        components: receipts.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Goods receipts · PO ${purchaseOrder}`,
                  columns: [
                    { key: 'doc', label: 'Material document' },
                    { key: 'item', label: 'Item' },
                    { key: 'date', label: 'Posted' },
                    { key: 'qty', label: 'Quantity', align: 'right' },
                  ],
                  rows: receipts.map((r) => ({ doc: r.materialDocument, item: r.item, date: r.postingDate, qty: `${r.quantity} ${r.unit}` })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseOrder', objectId: purchaseOrder, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'mm_getVendorDetails',
    domain: 'mm',
    title: 'Get vendor master data',
    description: 'Retrieve purchasing-relevant supplier master data (address, blocks).',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving vendor master data',
    input: { vendorId: z.string().regex(/^[A-Z0-9]{1,10}$/i) },
    async run({ vendorId }, ctx) {
      const v = await ctx.gateway.getVendor(ctx.sap, vendorId);
      return {
        data: {
          vendor: { id: v.id, name: v.name, country: v.country, city: v.city, postingBlocked: v.postingBlocked, paymentBlocked: v.paymentBlocked },
          summary: `**${v.name}** (${v.id}) — ${v.city ?? ''} ${v.country}. ${v.postingBlocked || v.paymentBlocked ? 'The supplier is **blocked**.' : 'No supplier blocks.'}`,
        },
        components: [{ type: 'vendor', data: { id: v.id, name: v.name, country: v.country, ...(v.city && { city: v.city }), blocked: v.postingBlocked || v.paymentBlocked } }],
        source: { system: ctx.gateway.systemId, objectType: 'Supplier', objectId: v.id, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'mm_createPurchaseRequisition',
    domain: 'mm',
    title: 'Create purchase requisition',
    description: 'Create a purchase requisition for a material and plant (for example when stock is below the reorder point). Requires explicit user confirmation.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating purchase requisition',
    input: { material, plant, quantity, deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Requested delivery date, YYYY-MM-DD') },
    async preview({ material, plant, quantity, deliveryDate }) {
      return {
        action: 'Create purchase requisition',
        businessObject: { type: 'Material', id: material },
        proposedChange: `Request ${quantity} of material ${material} for plant ${plant}${deliveryDate ? `, to be delivered by ${deliveryDate}` : ''}.`,
        impact: 'A purchase requisition is created and goes to purchasing for approval and sourcing. No order is placed with a supplier yet.',
      };
    },
    async run({ material, plant, quantity, deliveryDate }, ctx) {
      const pr = await ctx.gateway.createPurchaseRequisition(ctx.sap, { material, plant, quantity, ...(deliveryDate && { deliveryDate }) });
      return {
        data: { summary: `Purchase requisition **${pr.number}** was created for ${quantity} of material ${material}, worth about **${fmt(pr.value)}**.`, requisition: pr.number },
        components: [{ type: 'purchase_requisition', data: pr }],
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseRequisition', objectId: pr.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { purchaseRequisition: pr.number },
      };
    },
  }),

  defineTool({
    name: 'mm_createPurchaseOrder',
    domain: 'mm',
    title: 'Create purchase order',
    description:
      'Create a standard purchase order with one item for a supplier (transaction ME21N). Leave the price empty to use the info record price. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating purchase order',
    input: {
      supplier,
      material,
      plant,
      quantity,
      companyCode,
      purchasingOrganization: z.string().regex(/^[A-Z0-9]{4}$/).describe('Purchasing organization, e.g. 1030'),
      purchasingGroup: z.string().regex(/^[A-Z0-9]{3}$/).describe('Purchasing group, e.g. 103'),
      netPrice: z.coerce.number().positive().optional().describe('Net price per unit; omit to use the info record price'),
    },
    async preview({ supplier, material, plant, quantity, netPrice }, ctx) {
      const v = await ctx.gateway.getVendor(ctx.sap, supplier);
      return {
        action: 'Create purchase order',
        businessObject: { type: 'Supplier', id: v.id },
        proposedChange: `Order ${quantity} of material ${material} for plant ${plant} from ${v.name}${netPrice !== undefined ? ` at a net price of ${netPrice} per unit` : ' at the info record price'}.`,
        impact: `A binding purchase order is created for ${v.name}. It commits budget and, once sent, obliges the company to accept and pay for the goods.`,
      };
    },
    async run(args, ctx) {
      const { netPrice, ...order } = args;
      const po = await ctx.gateway.createPurchaseOrder(ctx.sap, { ...order, ...(netPrice !== undefined && { netPrice }) });
      return {
        data: { summary: `Purchase order **${po.number}** for **${po.vendorName}** was created, worth **${fmt(po.value)}**.`, purchaseOrder: po.number },
        components: [purchaseOrderComponent(po)],
        source: orderSource(ctx, po.number),
        outputs: { purchaseOrder: po.number, supplier: po.vendorId, companyCode: po.companyCode },
      };
    },
  }),

  defineTool({
    name: 'mm_postGoodsReceipt',
    domain: 'mm',
    title: 'Post goods receipt',
    description:
      'Post the goods receipt for all open quantities of a purchase order (transaction MIGO, movement type 101). Increases stock and posts to the GR/IR clearing account. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Posting goods receipt',
    input: { purchaseOrder: poNumber },
    async preview({ purchaseOrder }, ctx) {
      const po = await ctx.gateway.getPurchaseOrder(ctx.sap, purchaseOrder);
      const open = await openQuantities(ctx, po);
      return {
        action: 'Post goods receipt',
        businessObject: { type: 'Purchase order', id: po.number },
        proposedChange: open.length ? `Receive ${quantities(open)} from ${po.vendorName}.` : 'Nothing is open on this purchase order — SAP will reject this posting.',
        impact: 'Stock increases and the value is posted to inventory against the GR/IR clearing account. Only confirm if the goods have physically arrived; undoing it requires a reversal.',
      };
    },
    async run({ purchaseOrder }, ctx) {
      const receipts = await ctx.gateway.postGoodsReceipt(ctx.sap, purchaseOrder);
      const document = receipts[0]?.materialDocument ?? '';
      return {
        data: {
          summary: `Goods receipt **${document}** was posted for purchase order **${purchaseOrder}**: ${receipts.map((r) => `${r.quantity} ${r.unit}`).join(', ')}.`,
          materialDocument: document,
        },
        components: receipts.slice(0, 20).map((r) => ({ type: 'goods_receipt' as const, data: { materialDocument: r.materialDocument, year: r.year, purchaseOrder: r.purchaseOrder, postingDate: r.postingDate, quantity: r.quantity, unit: r.unit, ...(r.value && { value: r.value }) } })),
        source: orderSource(ctx, purchaseOrder),
        outputs: { materialDocument: document },
      };
    },
  }),

  defineTool({
    name: 'mm_createSupplierInvoice',
    domain: 'mm',
    title: 'Enter supplier invoice',
    description:
      "Post a supplier's invoice against a purchase order (transaction MIRO). SAP performs the three-way match and blocks the invoice for payment if price or quantity deviate. Consequential: always requires explicit user confirmation.",
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Posting supplier invoice',
    input: {
      purchaseOrder: poNumber,
      reference: z.string().trim().min(1).max(16).describe("The supplier's own invoice number, e.g. VEN003"),
      grossAmount: z.coerce.number().positive().describe('Gross amount on the invoice, including tax'),
      taxCode: z.string().regex(/^[A-Z0-9]{2}$/).optional().describe('Tax code, e.g. V1'),
    },
    async preview({ purchaseOrder, reference, grossAmount }, ctx) {
      const po = await ctx.gateway.getPurchaseOrder(ctx.sap, purchaseOrder);
      const gross = fmt({ amount: grossAmount, currency: po.value.currency });
      return {
        action: 'Enter supplier invoice',
        businessObject: { type: 'Purchase order', id: po.number },
        proposedChange: `Post invoice ${reference} from ${po.vendorName} for ${gross} gross against an order value of ${fmt(po.value)} net.`,
        impact: `A payable of ${gross} is posted to ${po.vendorName}. If the amount or quantity does not match the order and the goods received, SAP posts the invoice blocked for payment.`,
      };
    },
    async run({ purchaseOrder, reference, grossAmount, taxCode }, ctx) {
      const inv = await ctx.gateway.createSupplierInvoice(ctx.sap, { purchaseOrder, reference, grossAmount, ...(taxCode && { taxCode }) });
      const findings = (inv.varianceChecks ?? []).filter((c) => !c.withinTolerance).map((c) => c.message);
      return {
        data: {
          summary:
            `Supplier invoice **${inv.number}** from **${inv.vendorName}** for **${fmt(inv.gross)}** was posted` +
            (inv.paymentBlock ? `, but it is **blocked for payment** (${inv.paymentBlock.description}).` : ' and is open for payment.'),
          invoice: inv.number,
          findings,
        },
        components: [
          {
            type: 'invoice',
            data: {
              number: inv.number,
              fiscalYear: inv.fiscalYear,
              companyCode: inv.companyCode,
              vendorId: inv.vendorId,
              vendorName: inv.vendorName,
              amount: inv.gross,
              ...(inv.postingDate && { postingDate: inv.postingDate }),
              ...(inv.dueDate && { dueDate: inv.dueDate }),
              status: inv.status,
              paymentBlock: inv.paymentBlock,
              purchaseOrder,
              ...(findings.length && { blockReasons: findings }),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'SupplierInvoice', objectId: `${inv.number}/${inv.fiscalYear}`, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { invoice: inv.number, fiscalYear: inv.fiscalYear, paymentBlocked: String(!!inv.paymentBlock) },
      };
    },
  }),

  defineTool({
    name: 'mm_getMaterialStock',
    domain: 'mm',
    title: 'Get material stock',
    description: 'Retrieve the stock of a material by plant and storage location: unrestricted-use, quality-inspection and blocked quantities.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking material stock',
    input: { material, plant: plant.optional() },
    async run({ material, plant }, ctx) {
      const stock = await ctx.gateway.getMaterialStock(ctx.sap, material, plant);
      const unit = stock[0]!.unit;
      const unrestricted = stock.reduce((s, r) => s + r.unrestricted, 0);
      const name = stock[0]!.description;
      return {
        data: {
          stock,
          summary: `Material **${material}**${name ? ` (${name})` : ''} has **${unrestricted} ${unit}** in unrestricted-use stock${plant ? ` in plant ${plant}` : ` across ${new Set(stock.map((r) => r.plant)).size} plant(s)`}.`,
        },
        components: [
          {
            type: 'business_object_table',
            data: {
              title: `Stock · material ${material}`,
              columns: [
                { key: 'plant', label: 'Plant' },
                { key: 'location', label: 'Storage location' },
                { key: 'unrestricted', label: 'Unrestricted', align: 'right' },
                { key: 'quality', label: 'Quality inspection', align: 'right' },
                { key: 'blocked', label: 'Blocked', align: 'right' },
              ],
              rows: stock.slice(0, 200).map((r) => ({
                plant: r.plant,
                location: r.storageLocation ?? null,
                unrestricted: `${r.unrestricted} ${r.unit}`,
                quality: `${r.qualityInspection} ${r.unit}`,
                blocked: `${r.blocked} ${r.unit}`,
              })),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'MaterialStock', objectId: plant ? `${material}/${plant}` : material, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Sources of supply', prompt: `Which suppliers have info records for material ${material}?` }],
      };
    },
  }),

  defineTool({
    name: 'mm_getInfoRecords',
    domain: 'mm',
    title: 'Get purchasing info records',
    description: 'List the purchasing info records of a material: which suppliers it was bought from, at what price and delivery time, and the last purchase order. Use to choose a supplier.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving sources of supply',
    input: { material, supplier: z.string().regex(/^[A-Z0-9]{1,10}$/i).optional() },
    async run({ material, supplier }, ctx) {
      const records = await ctx.gateway.getInfoRecords(ctx.sap, material, supplier);
      const cheapest = [...records].sort((a, b) => a.netPrice.amount - b.netPrice.amount)[0];
      return {
        data: {
          infoRecords: records.map((r) => ({ ...r, netPrice: fmt(r.netPrice) })),
          summary: cheapest
            ? `${records.length} purchasing info record(s) exist for material **${material}**. Lowest price: **${fmt(cheapest.netPrice)}** from **${cheapest.supplierName ?? cheapest.supplier}**${cheapest.lastPurchaseOrder ? ` (last purchase order ${cheapest.lastPurchaseOrder})` : ''}.`
            : `No purchasing info records exist for material **${material}**${supplier ? ` and supplier ${supplier}` : ''}.`,
        },
        components: records.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Sources of supply · material ${material}`,
                  columns: [
                    { key: 'supplier', label: 'Supplier' },
                    { key: 'record', label: 'Info record' },
                    { key: 'price', label: 'Net price', align: 'right' },
                    { key: 'days', label: 'Delivery days', align: 'right' },
                    { key: 'lastOrder', label: 'Last PO' },
                  ],
                  rows: records.slice(0, 200).map((r) => ({
                    supplier: r.supplierName ? `${r.supplierName} (${r.supplier})` : r.supplier,
                    record: r.infoRecord,
                    price: fmt(r.netPrice),
                    days: r.plannedDeliveryDays ?? null,
                    lastOrder: r.lastPurchaseOrder ?? null,
                  })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'PurchasingInfoRecord', objectId: material, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'mm_listBlockedInvoices',
    domain: 'mm',
    title: 'List blocked invoices',
    description: 'List supplier invoices in a company code that are blocked for payment (transaction MRBR worklist).',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Finding blocked invoices',
    input: { companyCode },
    async run({ companyCode }, ctx) {
      const invoices = await ctx.gateway.listBlockedInvoices(ctx.sap, companyCode);
      const currency = invoices[0]?.gross.currency;
      const total = invoices.reduce((s, i) => s + i.gross.amount, 0);
      return {
        data: {
          invoices: invoices.map((i) => ({ number: i.number, vendor: i.vendorName, gross: fmt(i.gross), block: i.paymentBlock?.code, dueDate: i.dueDate })),
          summary: currency
            ? `${invoices.length} supplier invoice(s) totalling **${fmt({ amount: total, currency })}** are blocked for payment in company code ${companyCode}.`
            : `No supplier invoices are blocked for payment in company code ${companyCode}.`,
        },
        components: invoices.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Blocked invoices · company code ${companyCode}`,
                  columns: [
                    { key: 'invoice', label: 'Invoice' },
                    { key: 'vendor', label: 'Supplier' },
                    { key: 'block', label: 'Block' },
                    { key: 'due', label: 'Due' },
                    { key: 'amount', label: 'Gross amount', align: 'right' },
                  ],
                  rows: invoices.slice(0, 200).map((i) => ({
                    invoice: i.number,
                    vendor: i.vendorName,
                    block: i.paymentBlock ? `${i.paymentBlock.code} · ${i.paymentBlock.description}` : null,
                    due: i.dueDate ?? null,
                    amount: fmt(i.gross),
                  })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'BlockedInvoices', objectId: companyCode, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: invoices.slice(0, 2).map((i) => ({ label: `Analyze ${i.number}`, prompt: `Why is invoice ${i.number} blocked?` })),
      };
    },
  }),
];
