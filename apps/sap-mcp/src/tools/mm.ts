import { z } from 'zod';
import { companyCode } from './line-items.js';
import { defineTool, fmt, now } from './types.js';

const poNumber = z.string().regex(/^\d{10}$/).describe('Purchase order number, e.g. 4500012345');

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
        components: [
          {
            type: 'purchase_order',
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
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'PurchaseOrder', objectId: po.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [
          { label: 'Goods receipts', prompt: `Show goods receipts for purchase order ${po.number}.` },
          { label: 'Analyze vendor', prompt: `Review vendor ${po.vendorId} exposure.` },
        ],
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
