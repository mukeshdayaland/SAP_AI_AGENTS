import { z } from 'zod';
import type { DocumentFlowStep, SalesOrder } from '../sap/model.js';
import { defineTool, fmt, now, type ToolContext } from './types.js';

const salesOrder = z.string().regex(/^\d{1,10}$/).describe('Sales order number, e.g. 648');
const humanize = (s: string) => s.replaceAll('_', ' ').toLowerCase();

function salesOrderComponent(o: SalesOrder) {
  const blocks = [
    ...(o.creditStatus === 'BLOCKED' ? ['Credit block'] : []),
    ...(o.deliveryBlock ? [`Delivery block ${o.deliveryBlock}`] : []),
    ...(o.billingBlock ? [`Billing block ${o.billingBlock}`] : []),
  ];
  return {
    type: 'sales_order' as const,
    data: {
      number: o.number,
      orderType: o.orderType,
      salesArea: [o.salesOrganization, o.distributionChannel, o.division].filter(Boolean).join(' / '),
      soldTo: o.soldTo,
      soldToName: o.soldToName,
      ...(o.customerReference && { customerReference: o.customerReference }),
      netValue: o.netValue,
      ...(o.requestedDeliveryDate && { requestedDeliveryDate: o.requestedDeliveryDate }),
      deliveryStatus: o.deliveryStatus,
      billingStatus: o.billingStatus,
      creditStatus: o.creditStatus,
      ...(blocks.length && { blocks }),
      items: o.items.slice(0, 50).map((i) => ({ item: i.item, material: i.material, description: i.description, quantity: i.quantity, unit: i.unit, netValue: i.netValue })),
    },
  };
}

function salesOrderSummary(o: SalesOrder) {
  return (
    `Sales order **${o.number}** for **${o.soldToName}** is worth **${fmt(o.netValue)}**. ` +
    `Delivery: ${humanize(o.deliveryStatus)}; billing: ${humanize(o.billingStatus)}` +
    (o.creditStatus === 'BLOCKED' ? '; the order is **blocked by the credit check**.' : '.')
  );
}

const orderSource = (ctx: ToolContext, number: string) => ({ system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: number, retrievedAt: now(), mock: ctx.gateway.mock });

const FLOW_LABEL: Record<DocumentFlowStep['category'], string> = {
  DELIVERY: 'Outbound delivery',
  GOODS_ISSUE: 'Goods issue',
  BILLING: 'Billing document',
  ACCOUNTING: 'Accounting document',
  OTHER: 'Follow-on document',
};

/** SD: sales orders (VA01), outbound deliveries and goods issue (VL01N), billing documents (VF01). */
export const sdTools = [
  defineTool({
    name: 'sd_getSalesOrder',
    domain: 'sd',
    title: 'Get sales order',
    description: 'Retrieve a sales order with its items, delivery and billing status, and credit, delivery or billing blocks.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving sales order',
    input: { salesOrder },
    async run({ salesOrder }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      return {
        data: {
          salesOrder: { ...o, netValue: fmt(o.netValue), items: o.items.map((i) => `${i.item}: ${i.quantity} ${i.unit} ${i.description} = ${fmt(i.netValue)}`) },
          summary: salesOrderSummary(o),
        },
        components: [salesOrderComponent(o)],
        source: orderSource(ctx, o.number),
        followUps: [
          { label: 'Document flow', prompt: `Show the document flow of sales order ${o.number}.` },
          ...(o.creditStatus === 'BLOCKED' ? [{ label: 'Credit exposure', prompt: `Show the credit exposure of customer ${o.soldTo}.` }] : []),
        ],
      };
    },
  }),

  defineTool({
    name: 'sd_getSalesOrderFlow',
    domain: 'sd',
    title: 'Get sales order document flow',
    description:
      'Trace a sales order through order-to-cash: delivery, goods issue, billing document and accounting document. Use to find where an order is stuck.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Tracing the order-to-cash document flow',
    input: { salesOrder },
    async run({ salesOrder }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      const flow = await ctx.gateway.getSalesOrderFlow(ctx.sap, o.number);
      const has = (c: DocumentFlowStep['category']) => flow.some((s) => s.category === c);
      const nextSteps = [
        ...(o.creditStatus === 'BLOCKED' ? ['Review the credit exposure and release or reject the credit block.'] : []),
        ...(!has('DELIVERY') && o.creditStatus !== 'BLOCKED' ? ['Create the outbound delivery (VL01N).'] : []),
        ...(has('DELIVERY') && !has('GOODS_ISSUE') ? ['Post goods issue for the delivery.'] : []),
        ...(has('GOODS_ISSUE') && !has('BILLING') ? ['Create the billing document (VF01).'] : []),
        ...(has('BILLING') && !has('ACCOUNTING') ? ['Check why the billing document was not released to accounting.'] : []),
      ];
      return {
        data: {
          summary: `${salesOrderSummary(o)} ${flow.length ? `${flow.length} follow-on document(s) exist.` : 'No follow-on documents exist yet.'}`,
          flow: flow.map((s) => `${FLOW_LABEL[s.category]} ${s.document}${s.date ? ` on ${s.date}` : ''}${s.status ? ` (${s.status})` : ''}`),
          nextSteps,
        },
        components: [
          salesOrderComponent(o),
          {
            type: 'timeline',
            data: {
              title: `Document flow · sales order ${o.number}`,
              events: [
                { date: o.createdOn ?? '', title: `Sales order ${o.number}`, detail: `${o.soldToName} · ${fmt(o.netValue)}`, tone: o.creditStatus === 'BLOCKED' ? ('critical' as const) : ('positive' as const) },
                ...flow.slice(0, 99).map((s) => ({ date: s.date ?? '', title: `${FLOW_LABEL[s.category]} ${s.document}`, ...(s.status && { detail: s.status }), tone: 'positive' as const })),
              ],
            },
          },
        ],
        source: orderSource(ctx, o.number),
      };
    },
  }),

  defineTool({
    name: 'sd_listOpenSalesOrders',
    domain: 'sd',
    title: 'List open sales orders',
    description: 'List sales orders that are not yet completely delivered or billed, or are blocked. Use to find deliveries and billing that are due.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Finding open sales orders',
    input: { salesOrganization: z.string().regex(/^[A-Z0-9]{4}$/).optional().describe('Sales organization, e.g. 1030') },
    async run({ salesOrganization }, ctx) {
      const orders = await ctx.gateway.listOpenSalesOrders(ctx.sap, salesOrganization);
      const blocked = orders.filter((o) => o.creditStatus === 'BLOCKED');
      return {
        data: {
          summary: orders.length
            ? `${orders.length} sales order(s) are open${blocked.length ? `, ${blocked.length} of them blocked by the credit check` : ''}.`
            : 'No open sales orders were found.',
          orders: orders.map((o) => ({ number: o.number, customer: o.soldToName, value: fmt(o.netValue), requestedDeliveryDate: o.requestedDeliveryDate, delivery: o.deliveryStatus, billing: o.billingStatus, credit: o.creditStatus })),
        },
        components: orders.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Open sales orders${salesOrganization ? ` · sales organization ${salesOrganization}` : ''}`,
                  columns: [
                    { key: 'order', label: 'Order' },
                    { key: 'customer', label: 'Customer' },
                    { key: 'requested', label: 'Requested delivery' },
                    { key: 'value', label: 'Net value', align: 'right' },
                    { key: 'delivery', label: 'Delivery' },
                    { key: 'billing', label: 'Billing' },
                    { key: 'credit', label: 'Credit' },
                  ],
                  rows: orders.slice(0, 200).map((o) => ({
                    order: o.number,
                    customer: o.soldToName,
                    requested: o.requestedDeliveryDate ?? null,
                    value: fmt(o.netValue),
                    delivery: humanize(o.deliveryStatus),
                    billing: humanize(o.billingStatus),
                    credit: humanize(o.creditStatus),
                  })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'OpenSalesOrders', objectId: salesOrganization ?? 'all', retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'sd_getDelivery',
    domain: 'sd',
    title: 'Get outbound delivery',
    description: 'Retrieve an outbound delivery with its items, picking status and goods issue status.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving outbound delivery',
    input: { delivery: z.string().regex(/^\d{1,10}$/).describe('Outbound delivery number, e.g. 80000257') },
    async run({ delivery }, ctx) {
      const d = await ctx.gateway.getDelivery(ctx.sap, delivery);
      return {
        data: {
          delivery: d,
          summary:
            `Outbound delivery **${d.number}** to **${d.shipToName}**: goods issue is **${humanize(d.goodsIssueStatus)}**` +
            (d.actualGoodsIssueDate ? ` (posted ${d.actualGoodsIssueDate}).` : d.plannedGoodsIssueDate ? ` (planned ${d.plannedGoodsIssueDate}).` : '.'),
        },
        components: [
          {
            type: 'outbound_delivery',
            data: {
              number: d.number,
              shipTo: d.shipTo,
              shipToName: d.shipToName,
              ...(d.salesOrder && { salesOrder: d.salesOrder }),
              ...(d.plannedGoodsIssueDate && { plannedGoodsIssueDate: d.plannedGoodsIssueDate }),
              ...(d.actualGoodsIssueDate && { actualGoodsIssueDate: d.actualGoodsIssueDate }),
              goodsIssueStatus: d.goodsIssueStatus,
              items: d.items.slice(0, 50),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'OutboundDelivery', objectId: d.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: d.salesOrder ? [{ label: 'Sales order', prompt: `Show sales order ${d.salesOrder}.` }] : [],
      };
    },
  }),

  defineTool({
    name: 'sd_getBillingDocument',
    domain: 'sd',
    title: 'Get billing document',
    description: 'Retrieve a billing document (customer invoice) with its value and whether it was posted to accounting, including the accounting document number.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving billing document',
    input: { billingDocument: z.string().regex(/^\d{1,10}$/).describe('Billing document number, e.g. 90000181') },
    async run({ billingDocument }, ctx) {
      const b = await ctx.gateway.getBillingDocument(ctx.sap, billingDocument);
      return {
        data: {
          billingDocument: { ...b, netValue: fmt(b.netValue), taxAmount: b.taxAmount ? fmt(b.taxAmount) : undefined, items: b.items.map((i) => `${i.item}: ${i.quantity} ${i.unit} ${i.description} = ${fmt(i.netValue)}`) },
          summary:
            `Billing document **${b.number}** for **${b.payerName}** has a net value of **${fmt(b.netValue)}**. ` +
            (b.cancelled
              ? 'It has been **cancelled**.'
              : b.postedToAccounting
                ? `It is posted to accounting${b.accountingDocument ? ` as document **${b.accountingDocument}**` : ''}.`
                : 'It is **not yet posted to accounting**.'),
          findings: !b.cancelled && !b.postedToAccounting ? ['The billing document has no accounting document: check account determination and the posting block (VFX3).'] : [],
        },
        components: [
          {
            type: 'billing_document',
            data: {
              number: b.number,
              billingType: b.billingType,
              payer: b.payer,
              payerName: b.payerName,
              billingDate: b.billingDate,
              netValue: b.netValue,
              ...(b.taxAmount && { taxAmount: b.taxAmount }),
              companyCode: b.companyCode,
              ...(b.accountingDocument && { accountingDocument: b.accountingDocument }),
              postedToAccounting: b.postedToAccounting,
              cancelled: b.cancelled,
              ...(b.salesOrder && { salesOrder: b.salesOrder }),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'BillingDocument', objectId: b.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [
          ...(b.accountingDocument && b.fiscalYear
            ? [{ label: 'Accounting document', prompt: `Show accounting document ${b.accountingDocument} in company code ${b.companyCode} for fiscal year ${b.fiscalYear}.` }]
            : []),
          { label: 'Customer open items', prompt: `Show the open items of customer ${b.payer} in company code ${b.companyCode}.` },
        ],
      };
    },
  }),
];
