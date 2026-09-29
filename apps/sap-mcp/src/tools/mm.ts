import { z } from 'zod';
import { defineTool, fmt, now } from './types.js';

const poNumber = z.string().regex(/^\d{10}$/).describe('Purchase order number, e.g. 4500012345');

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
];
