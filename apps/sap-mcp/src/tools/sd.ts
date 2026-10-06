import { z } from 'zod';
import { SapError, type BillingDocument, type DocumentFlowStep, type IncompletionEntry, type OutboundDelivery, type SalesOrder } from '../sap/model.js';
import { defineTool, fmt, now, type ToolContext } from './types.js';

export const salesOrder = z.string().regex(/^\d{1,10}$/).describe('Sales order number, e.g. 648');
export const billingNumber = z.string().regex(/^\d{1,10}$/).describe('Billing document number, e.g. 90000181');
const humanize = (s: string) => s.replaceAll('_', ' ').toLowerCase();

export function salesOrderComponent(o: SalesOrder, missing: IncompletionEntry[] = []) {
  const blocks = [
    ...(missing.some((e) => e.blocksDelivery) ? ['Incomplete: blocks delivery'] : missing.length ? ['Incomplete'] : []),
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

export function deliveryComponent(d: OutboundDelivery) {
  return {
    type: 'outbound_delivery' as const,
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
  };
}

function billingComponent(b: BillingDocument) {
  return {
    type: 'billing_document' as const,
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

/** The delivery of a sales order that is ready for the next step, or a business-rule error that says why there is none. */
export async function findDelivery(ctx: ToolContext, salesOrder: string, ready: (d: OutboundDelivery) => boolean, none: string): Promise<OutboundDelivery> {
  const flow = await ctx.gateway.getSalesOrderFlow(ctx.sap, salesOrder);
  for (const step of flow.filter((s) => s.category === 'DELIVERY')) {
    const delivery = await ctx.gateway.getDelivery(ctx.sap, step.document);
    if (ready(delivery)) return delivery;
  }
  throw new SapError('BUSINESS_RULE', none);
}

/** The incompletion log, or undefined where the system has no incompletion log service. */
export const readIncompletion = (ctx: ToolContext, salesDocument: string) => ctx.gateway.getIncompletionLog(ctx.sap, salesDocument).catch(() => undefined);

/** "item 10: Storage Location, Gross Weight; header: Purchase Order Number" */
export function describeMissing(entries: IncompletionEntry[]): string {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const where = e.item ? `item ${e.item}` : 'header';
    const field = e.partnerFunction ? `${e.field} (partner function ${e.partnerFunction})` : e.field;
    groups.set(where, [...new Set([...(groups.get(where) ?? []), field])]);
  }
  return [...groups.entries()].map(([where, fields]) => `${where}: ${fields.join(', ')}`).join('; ');
}

/** Where each kind of missing data can be completed. */
export function completionHint(entries: IncompletionEntry[]): string {
  const names = new Set(entries.map((e) => e.fieldName));
  const here = ['BSTKD', 'ZTERM', 'INCO1', 'INCO2', 'VSTEL', 'LGORT', 'VDATU', 'BRGEW', 'NTGEW', 'GEWEI'].filter((f) => names.has(f));
  const other = entries.filter((e) => !here.includes(e.fieldName));
  return [
    ...(here.length ? ['The purchase order number, payment terms, Incoterms, delivery date, shipping point, storage location and item weights can be completed here.'] : []),
    ...(other.length ? [`Complete ${[...new Set(other.map((e) => e.field))].join(', ')} in VA02 (Edit > Incompletion log).`] : []),
  ].join(' ');
}

/** Order data that incompletion procedures usually require and that is empty on this order. */
export function orderGaps(o: SalesOrder): string[] {
  return [
    ...(o.customerReference ? [] : ['customer purchase order number']),
    ...(o.paymentTerms ? [] : ['payment terms']),
    ...(o.incoterms ? [] : ['Incoterms']),
    ...(o.requestedDeliveryDate ? [] : ['requested delivery date']),
    ...o.items.flatMap((i) => [
      ...(i.netValue.amount > 0 ? [] : [`price of item ${i.item}`]),
      ...(i.plant ? [] : [`plant of item ${i.item}`]),
      ...(i.shippingPoint ? [] : [`shipping point of item ${i.item}`]),
    ]),
  ];
}

/**
 * SAP says only "order is incomplete". Adds what is missing from the incompletion log, or, where the
 * log cannot be read, which of the usual fields are empty.
 */
async function explainIncomplete(ctx: ToolContext, salesOrder: string, err: unknown): Promise<unknown> {
  if (!(err instanceof SapError) || !/incomplete/i.test(err.message)) return err;
  const log = await readIncompletion(ctx, salesOrder);
  if (log?.length) return new SapError(err.code, `${err.message}. Missing: ${describeMissing(log)}. ${completionHint(log)}`);
  const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder).catch(() => undefined);
  const gaps = o ? orderGaps(o) : [];
  const where = 'The complete list is in the incompletion log of the order in SAP (VA02, Edit > Incompletion log).';
  return new SapError(
    err.code,
    gaps.length
      ? `${err.message}. Empty on the order and usually required: ${gaps.join(', ')}. ${where}`
      : `${err.message}. None of the usual fields is empty. ${where}`,
  );
}

export const quantities = (items: { quantity: number; unit: string; description: string }[]) => items.map((i) => `${i.quantity} ${i.unit} ${i.description}`).join(', ');

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
      const [o, missing = []] = await Promise.all([ctx.gateway.getSalesOrder(ctx.sap, salesOrder), readIncompletion(ctx, salesOrder)]);
      return {
        data: {
          salesOrder: { ...o, netValue: fmt(o.netValue), items: o.items.map((i) => `${i.item}: ${i.quantity} ${i.unit} of material ${i.material} (${i.description})${i.plant ? `, plant ${i.plant}` : ''}${i.weightUnit ? `, gross weight ${i.grossWeight} ${i.weightUnit}, net weight ${i.netWeight} ${i.weightUnit}` : ''} = ${fmt(i.netValue)}`) },
          summary: salesOrderSummary(o),
          ...(missing.length && { incomplete: `${describeMissing(missing)}${missing.some((e) => e.blocksDelivery) ? ' (blocks the delivery)' : ''}` }),
        },
        components: [salesOrderComponent(o, missing)],
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
        outputs: {
          salesOrder: o.number,
          soldTo: o.soldTo,
          creditStatus: o.creditStatus,
          hasDelivery: String(has('DELIVERY')),
          goodsIssued: String(has('GOODS_ISSUE')),
          billed: String(has('BILLING')),
        },
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
        components: [deliveryComponent(d)],
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
    input: { billingDocument: billingNumber },
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
        components: [billingComponent(b)],
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

  defineTool({
    name: 'sd_getIncompletionLog',
    domain: 'sd',
    title: 'Get incompletion log',
    description:
      'List the data still missing in a sales order (VA02, Edit > Incompletion log) and whether it blocks the delivery or billing. Use it before creating a delivery and whenever SAP reports an order as incomplete.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking order completeness',
    input: { salesOrder },
    async run({ salesOrder }, ctx) {
      const log = await ctx.gateway.getIncompletionLog(ctx.sap, salesOrder);
      const blocking = log.filter((e) => e.blocksDelivery);
      return {
        data: {
          summary: log.length
            ? `Sales order **${salesOrder}** is incomplete${blocking.length ? ' and **cannot be delivered** yet' : ''}. Missing: ${describeMissing(log)}. ${completionHint(log)}`
            : `Sales order **${salesOrder}** is complete: nothing is missing for delivery or billing.`,
          missing: log.map((e) => ({ item: e.item ?? 'header', field: e.field, sapField: `${e.table}-${e.fieldName}`, blocksDelivery: e.blocksDelivery, blocksBilling: e.blocksBilling })),
        },
        components: log.length
          ? [
              {
                type: 'business_object_table' as const,
                data: {
                  title: `Incompletion log · sales order ${salesOrder}`,
                  columns: [
                    { key: 'item', label: 'Item' },
                    { key: 'field', label: 'Missing data' },
                    { key: 'blocks', label: 'Blocks' },
                  ],
                  rows: log.slice(0, 200).map((e) => ({
                    item: e.item ?? 'Header',
                    field: e.partnerFunction ? `${e.field} (${e.partnerFunction})` : e.field,
                    blocks: [...(e.blocksDelivery ? ['Delivery'] : []), ...(e.blocksBilling ? ['Billing'] : [])].join(', ') || '—',
                  })),
                },
              },
            ]
          : [],
        source: orderSource(ctx, salesOrder),
        followUps: blocking.length ? [] : [{ label: 'Create the delivery', prompt: `Create the outbound delivery for sales order ${salesOrder}.` }],
        outputs: { complete: String(log.length === 0), blocksDelivery: String(blocking.length > 0) },
      };
    },
  }),

  defineTool({
    name: 'sd_createDelivery',
    domain: 'sd',
    title: 'Create outbound delivery',
    description: 'Create an outbound delivery for the open items of a sales order (transaction VL01N). Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating outbound delivery',
    input: { salesOrder },
    async preview({ salesOrder }, ctx) {
      const [o, missing = []] = await Promise.all([ctx.gateway.getSalesOrder(ctx.sap, salesOrder), readIncompletion(ctx, salesOrder)]);
      const blocking = missing.filter((e) => e.blocksDelivery);
      if (blocking.length) {
        return {
          action: 'Create outbound delivery',
          businessObject: { type: 'Sales order', id: o.number },
          proposedChange: `Sales order ${o.number} is incomplete, so SAP will reject this delivery. Missing: ${describeMissing(blocking)}.`,
          impact: `Complete the order first. ${completionHint(blocking)}`,
        };
      }
      return {
        action: 'Create outbound delivery',
        businessObject: { type: 'Sales order', id: o.number },
        proposedChange: `Create an outbound delivery to ${o.soldToName} for ${quantities(o.items)}.`,
        impact: `Stock is committed to this delivery and warehouse processing can start. The order value is ${fmt(o.netValue)}.`,
      };
    },
    async run({ salesOrder }, ctx) {
      const d = await ctx.gateway.createDelivery(ctx.sap, salesOrder).catch(async (err: unknown) => {
        throw await explainIncomplete(ctx, salesOrder, err);
      });
      return {
        data: { summary: `Outbound delivery **${d.number}** was created for sales order **${salesOrder}**. Goods issue is still outstanding.`, delivery: d.number },
        components: [deliveryComponent(d)],
        source: { system: ctx.gateway.systemId, objectType: 'OutboundDelivery', objectId: d.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { delivery: d.number },
      };
    },
  }),

  defineTool({
    name: 'sd_postGoodsIssue',
    domain: 'sd',
    title: 'Post goods issue',
    description: 'Post goods issue for the outbound delivery of a sales order. Reduces stock and posts cost of goods sold. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Posting goods issue',
    input: { salesOrder },
    async preview({ salesOrder }, ctx) {
      const d = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus !== 'COMPLETE', `Sales order ${salesOrder} has no delivery that is waiting for goods issue.`);
      return {
        action: 'Post goods issue',
        businessObject: { type: 'Outbound delivery', id: d.number },
        proposedChange: `Post goods issue for ${quantities(d.items)} to ${d.shipToName}.`,
        impact: 'Stock is reduced and cost of goods sold is posted to accounting. Undoing it requires a goods issue reversal.',
      };
    },
    async run({ salesOrder }, ctx) {
      const open = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus !== 'COMPLETE', `Sales order ${salesOrder} has no delivery that is waiting for goods issue.`);
      const d = await ctx.gateway.postGoodsIssue(ctx.sap, open.number);
      return {
        data: { summary: `Goods issue was posted for delivery **${d.number}**${d.actualGoodsIssueDate ? ` on ${d.actualGoodsIssueDate}` : ''}. The delivery can now be billed.`, delivery: d.number },
        components: [deliveryComponent(d)],
        source: { system: ctx.gateway.systemId, objectType: 'OutboundDelivery', objectId: d.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { delivery: d.number },
      };
    },
  }),

  defineTool({
    name: 'sd_createBillingDocument',
    domain: 'sd',
    title: 'Create billing document',
    description: 'Bill the goods-issued delivery of a sales order (transaction VF01) and post the invoice to accounting. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating billing document',
    input: { salesOrder },
    async preview({ salesOrder }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      if (o.billingStatus === 'COMPLETE') throw new SapError('BUSINESS_RULE', `Sales order ${salesOrder} is already completely billed.`);
      const d = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus === 'COMPLETE', `Sales order ${salesOrder} has no goods-issued delivery to bill.`);
      return {
        action: 'Create billing document',
        businessObject: { type: 'Outbound delivery', id: d.number },
        proposedChange: `Create a customer invoice for ${quantities(d.items)} delivered to ${o.soldToName}.`,
        impact: `A receivable of about ${fmt(o.netValue)} plus tax is posted to the account of ${o.soldToName} and revenue is recognized.`,
      };
    },
    async run({ salesOrder }, ctx) {
      const d = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus === 'COMPLETE', `Sales order ${salesOrder} has no goods-issued delivery to bill.`);
      const b = await ctx.gateway.createBillingDocument(ctx.sap, d.number);
      return {
        data: {
          summary: `Billing document **${b.number}** for **${fmt(b.netValue)}** was created for **${b.payerName}**${b.accountingDocument ? ` and posted to accounting as document **${b.accountingDocument}**` : ''}.`,
          billingDocument: b.number,
        },
        components: [billingComponent(b)],
        source: { system: ctx.gateway.systemId, objectType: 'BillingDocument', objectId: b.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { billingDocument: b.number, ...(b.accountingDocument && { accountingDocument: b.accountingDocument }), companyCode: b.companyCode },
      };
    },
  }),
];
