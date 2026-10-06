import { z } from 'zod';
import { SapError, type NewSalesOrder, type SalesOrderChange } from '../sap/model.js';
import { partnerNumber } from './line-items.js';
import { billingNumber, deliveryComponent, findDelivery, quantities, salesOrder, salesOrderComponent } from './sd.js';
import { defineTool, fmt, now } from './types.js';

const orderInput = {
  customer: partnerNumber.describe('Sold-to customer number, e.g. 7000000010'),
  material: z.string().regex(/^[A-Z0-9-]{1,40}$/i).describe('Material number as in SAP (not its description), e.g. 5496. To copy an order, take it from that order\'s items.'),
  quantity: z.coerce.number().positive().max(1_000_000).describe('Order quantity in the sales unit'),
  salesOrganization: z.string().regex(/^[A-Z0-9]{4}$/).describe('Sales organization, e.g. 1030'),
  distributionChannel: z.string().regex(/^[A-Z0-9]{2}$/).default('10').describe('Distribution channel, e.g. 10'),
  division: z.string().regex(/^[A-Z0-9]{2}$/).default('00').describe('Division, e.g. 00'),
  customerReference: z.string().trim().min(1).max(35).optional().describe("The customer's purchase order number"),
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Requested delivery date, YYYY-MM-DD'),
};

type OrderArgs = { customer: string; material: string; quantity: number; salesOrganization: string; distributionChannel: string; division: string; customerReference?: string | undefined; requestedDeliveryDate?: string | undefined };

const toOrder = (a: OrderArgs): NewSalesOrder => ({
  soldTo: a.customer,
  material: a.material,
  quantity: a.quantity,
  salesOrganization: a.salesOrganization,
  distributionChannel: a.distributionChannel,
  division: a.division,
  ...(a.customerReference && { customerReference: a.customerReference }),
  ...(a.requestedDeliveryDate && { requestedDeliveryDate: a.requestedDeliveryDate }),
});

type ChangeArgs = { [K in keyof SalesOrderChange]?: string | undefined };

function changeOf(a: ChangeArgs): SalesOrderChange {
  const change = Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as SalesOrderChange;
  if (!Object.keys(change).length) throw new SapError('INVALID_INPUT', 'Say what to change on the sales order: purchase order number, payment terms, Incoterms, delivery date, shipping point or storage location.');
  return change;
}

const CHANGE_LABEL: Record<keyof SalesOrderChange, string> = {
  customerReference: 'customer purchase order number',
  paymentTerms: 'payment terms',
  incoterms: 'Incoterms',
  incotermsLocation: 'Incoterms location',
  requestedDeliveryDate: 'requested delivery date',
  shippingPoint: 'shipping point of all items',
  storageLocation: 'storage location of all items',
};

const describeChange = (c: SalesOrderChange) =>
  (Object.entries(c) as [keyof SalesOrderChange, string][]).map(([k, v]) => `${CHANGE_LABEL[k]} ${v}`).join(', ');

const CREDIT_TEXT = { APPROVED: 'the credit check is passed', BLOCKED: 'the order would be **blocked by the credit check**', NOT_CHECKED: 'no credit check applies' } as const;

/** SD: entering sales orders, releasing credit blocks, and correcting deliveries and invoices. */
export const sdProcessTools = [
  defineTool({
    name: 'sd_simulateSalesOrder',
    domain: 'sd',
    title: 'Simulate sales order',
    description: 'Check price, availability and credit for a sales order without saving it. Use before creating a sales order.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Simulating sales order',
    input: orderInput,
    async run(args, ctx) {
      const s = await ctx.gateway.simulateSalesOrder(ctx.sap, toOrder(args));
      const short = s.items.filter((i) => i.confirmedQuantity !== undefined && i.confirmedQuantity < i.quantity);
      return {
        data: {
          summary:
            `An order of ${quantities(s.items)} for **${s.soldToName}** would be worth **${fmt(s.netValue)}** net${s.taxAmount ? ` plus ${fmt(s.taxAmount)} tax` : ''}; ${CREDIT_TEXT[s.creditStatus]}.` +
            (short.length ? ` Only ${short.map((i) => `${i.confirmedQuantity} of ${i.quantity} ${i.unit}`).join(', ')} can be confirmed from stock.` : ''),
          netValue: fmt(s.netValue),
          creditStatus: s.creditStatus,
        },
        components: [
          {
            type: 'kpi_block',
            data: {
              title: `Order simulation · ${s.soldToName}`,
              items: [
                { label: 'Net value', value: fmt(s.netValue) },
                ...(s.taxAmount ? [{ label: 'Tax', value: fmt(s.taxAmount) }] : []),
                { label: 'Credit check', value: s.creditStatus === 'BLOCKED' ? 'Would be blocked' : s.creditStatus === 'APPROVED' ? 'Passed' : 'Not checked', tone: s.creditStatus === 'BLOCKED' ? ('critical' as const) : ('positive' as const) },
                ...s.items.slice(0, 4).map((i) => ({
                  label: `Confirmed · ${i.material}`.slice(0, 80),
                  value: i.confirmedQuantity === undefined ? 'n/a' : `${i.confirmedQuantity} of ${i.quantity} ${i.unit}`,
                  tone: i.confirmedQuantity !== undefined && i.confirmedQuantity < i.quantity ? ('warning' as const) : ('positive' as const),
                })),
              ],
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrderSimulation', objectId: s.soldTo, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { creditStatus: s.creditStatus },
      };
    },
  }),

  defineTool({
    name: 'sd_createSalesOrder',
    domain: 'sd',
    title: 'Create sales order',
    description: 'Create a standard sales order for a customer (transaction VA01). SAP prices the order and runs the credit check. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating sales order',
    input: orderInput,
    async preview(args, ctx) {
      const s = await ctx.gateway.simulateSalesOrder(ctx.sap, toOrder(args));
      return {
        action: 'Create sales order',
        businessObject: { type: 'Customer', id: s.soldTo },
        proposedChange: `Create a sales order for ${s.soldToName}: ${quantities(s.items)}, about ${fmt(s.netValue)} net.`,
        impact:
          s.creditStatus === 'BLOCKED'
            ? 'The order would exceed the customer’s credit limit, so SAP will save it blocked by the credit check. It cannot be delivered until the block is released.'
            : 'The order is binding for the customer and counts towards their credit exposure. Stock is reserved when the delivery is created.',
      };
    },
    async run(args, ctx) {
      const o = await ctx.gateway.createSalesOrder(ctx.sap, toOrder(args));
      return {
        data: {
          summary: `Sales order **${o.number}** for **${o.soldToName}** was created with a net value of **${fmt(o.netValue)}**${o.creditStatus === 'BLOCKED' ? ', but it is **blocked by the credit check**.' : '.'}`,
          salesOrder: o.number,
          creditStatus: o.creditStatus,
        },
        components: [salesOrderComponent(o)],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: o.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: o.creditStatus === 'BLOCKED' ? [] : [{ label: 'Run order-to-cash', prompt: `Run order-to-cash for sales order ${o.number} in company code ${o.salesOrganization}.` }],
        outputs: { salesOrder: o.number, soldTo: o.soldTo, creditStatus: o.creditStatus },
      };
    },
  }),

  defineTool({
    name: 'sd_releaseCreditBlock',
    domain: 'sd',
    title: 'Release credit block',
    description: 'Release a sales order that is blocked by the credit check, so it can be delivered. Needs SAP credit release authorization. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Releasing credit block',
    input: { salesOrder },
    async preview({ salesOrder }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      const credit = await ctx.gateway.getCreditProfile(ctx.sap, o.soldTo).catch(() => undefined);
      return {
        action: 'Release credit block',
        businessObject: { type: 'Sales order', id: o.number },
        proposedChange: o.creditStatus === 'BLOCKED' ? `Release the credit block on the ${fmt(o.netValue)} order of ${o.soldToName}.` : 'This order is not blocked by the credit check — SAP will reject this action.',
        impact: credit
          ? `${o.soldToName} has a credit limit of ${fmt(credit.limit)} and an exposure of ${fmt(credit.exposure)}. After the release the order can be delivered and billed despite the exceeded limit.`
          : 'After the release the order can be delivered and billed although the credit check failed.',
      };
    },
    async run({ salesOrder }, ctx) {
      const o = await ctx.gateway.releaseCreditBlock(ctx.sap, salesOrder);
      return {
        data: { summary: `The credit block on sales order **${o.number}** was released. The order can now be delivered.`, salesOrder: o.number, creditStatus: o.creditStatus },
        components: [salesOrderComponent(o)],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: o.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { salesOrder: o.number, creditStatus: o.creditStatus },
      };
    },
  }),

  defineTool({
    name: 'sd_setItemPrice',
    domain: 'sd',
    title: 'Set sales order item price',
    description:
      'Set the price per unit of a sales order item (transaction VA02), for example when the order is incomplete because SAP found no price. Changes the existing price condition or adds a manual one. Consequential: always requires explicit user confirmation.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Setting item price',
    input: {
      salesOrder,
      item: z.string().regex(/^\d{1,6}$/).default('10').describe('Item number, e.g. 10'),
      price: z.coerce.number().positive().max(1_000_000_000).describe('Price per unit, net'),
      currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
      conditionType: z.string().regex(/^[A-Z0-9]{4}$/).optional().describe("Price condition type. Omit it: the item's own price condition (PPR0 or PR00) is found automatically."),
    },
    async preview({ salesOrder, item, price, currency }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      const line = o.items.find((i) => i.item.replace(/^0+/, '') === item.replace(/^0+/, ''));
      if (!line) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} has no item ${item}.`);
      const total = { amount: Math.round(price * line.quantity * 100) / 100, currency };
      return {
        action: 'Set item price',
        businessObject: { type: 'Sales order', id: o.number },
        proposedChange: `Set the price of item ${line.item} (${line.quantity} ${line.unit} ${line.description}) to ${fmt({ amount: price, currency })} per ${line.unit}: item value ${fmt(line.netValue)} → ${fmt(total)}.`,
        impact: `The order value changes for ${o.soldToName} and is used for delivery, billing and the credit check.`,
      };
    },
    async run({ salesOrder, item, price, currency, conditionType }, ctx) {
      const o = await ctx.gateway.setSalesOrderItemPrice(ctx.sap, salesOrder, item, price, currency, conditionType);
      return {
        data: { summary: `The price of item ${item} of sales order **${o.number}** was set to **${fmt({ amount: price, currency })}**. The order is now worth **${fmt(o.netValue)}**.`, salesOrder: o.number },
        components: [salesOrderComponent(o)],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: o.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Create the delivery', prompt: `Create the outbound delivery for sales order ${o.number}.` }],
        outputs: { salesOrder: o.number },
      };
    },
  }),

  defineTool({
    name: 'sd_updateSalesOrder',
    domain: 'sd',
    title: 'Change sales order',
    description:
      "Change the header data of a sales order (transaction VA02): the customer's purchase order number, payment terms, Incoterms, requested delivery date, or the shipping point or storage location of its items. Use it to complete an order that SAP reports as incomplete. Only pass the fields to change. Requires user confirmation.",
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Changing sales order',
    input: {
      salesOrder,
      customerReference: z.string().trim().min(1).max(35).optional().describe("The customer's purchase order number"),
      paymentTerms: z.string().regex(/^[A-Z0-9]{4}$/).optional().describe('Payment terms key, e.g. 0001'),
      incoterms: z.string().regex(/^[A-Z]{3}$/).optional().describe('Incoterms, e.g. EXW, FOB or DAP'),
      incotermsLocation: z.string().trim().min(1).max(70).optional().describe('Incoterms location, e.g. Riyadh'),
      requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Requested delivery date, YYYY-MM-DD'),
      shippingPoint: z.string().regex(/^[A-Z0-9]{4}$/).optional().describe('Shipping point for all items, e.g. 1030'),
      storageLocation: z.string().regex(/^[A-Z0-9]{4}$/).optional().describe('Storage location for all items, e.g. 101A'),
    },
    async preview({ salesOrder, ...change }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      return {
        action: 'Change sales order',
        businessObject: { type: 'Sales order', id: o.number },
        proposedChange: `Change sales order ${o.number} of ${o.soldToName}: ${describeChange(changeOf(change))}.`,
        impact: 'The order data is used for the delivery, the invoice and the payment due date.',
      };
    },
    async run({ salesOrder, ...change }, ctx) {
      const o = await ctx.gateway.updateSalesOrder(ctx.sap, salesOrder, changeOf(change));
      return {
        data: { summary: `Sales order **${o.number}** was changed: ${describeChange(changeOf(change))}.`, salesOrder: o.number },
        components: [salesOrderComponent(o)],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: o.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Create the delivery', prompt: `Create the outbound delivery for sales order ${o.number}.` }],
        outputs: { salesOrder: o.number },
      };
    },
  }),

  defineTool({
    name: 'sd_setItemWeight',
    domain: 'sd',
    title: 'Set sales order item weight',
    description:
      "Set the gross and net weight of a sales order item (VA02, item, Shipping tab), for example when the order is incomplete because the weight is missing. Weights from a later material master change do not reach existing orders, so they are set here. Requires user confirmation.",
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Setting item weight',
    input: {
      salesOrder,
      item: z.string().regex(/^\d{1,6}$/).default('10').describe('Item number, e.g. 10'),
      grossWeight: z.coerce.number().positive().max(1_000_000_000).describe('Gross weight of the whole item quantity'),
      netWeight: z.coerce.number().positive().max(1_000_000_000).describe('Net weight of the whole item quantity; not more than the gross weight'),
      weightUnit: z.string().regex(/^[A-Z0-9]{1,3}$/).default('KG').describe('Weight unit, e.g. KG'),
    },
    async preview({ salesOrder, item, grossWeight, netWeight, weightUnit }, ctx) {
      const o = await ctx.gateway.getSalesOrder(ctx.sap, salesOrder);
      const line = o.items.find((i) => i.item.replace(/^0+/, '') === item.replace(/^0+/, ''));
      if (!line) throw new SapError('NOT_FOUND', `Sales order ${salesOrder} has no item ${item}.`);
      const now = line.weightUnit && line.grossWeight ? `${line.grossWeight} / ${line.netWeight} ${line.weightUnit}` : 'none';
      return {
        action: 'Set item weight',
        businessObject: { type: 'Sales order', id: o.number },
        proposedChange:
          netWeight > grossWeight
            ? 'The net weight is more than the gross weight — SAP will reject this change.'
            : `Set the weight of item ${line.item} (${line.quantity} ${line.unit} ${line.description}) to ${grossWeight} ${weightUnit} gross and ${netWeight} ${weightUnit} net (now: ${now}).`,
        impact: 'The weights go to the delivery, shipping documents and freight calculation.',
      };
    },
    async run({ salesOrder, item, grossWeight, netWeight, weightUnit }, ctx) {
      const o = await ctx.gateway.setSalesOrderItemWeight(ctx.sap, salesOrder, item, grossWeight, netWeight, weightUnit);
      return {
        data: { summary: `Item ${item} of sales order **${o.number}** now weighs **${grossWeight} ${weightUnit}** gross and **${netWeight} ${weightUnit}** net.`, salesOrder: o.number },
        components: [salesOrderComponent(o)],
        source: { system: ctx.gateway.systemId, objectType: 'SalesOrder', objectId: o.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Check what is missing', prompt: `What is still missing on sales order ${o.number}?` }],
        outputs: { salesOrder: o.number },
      };
    },
  }),

  defineTool({
    name: 'sd_reverseGoodsIssue',
    domain: 'sd',
    title: 'Reverse goods issue',
    description: 'Reverse the goods issue of the outbound delivery of a sales order (transaction VL09). The stock returns and cost of goods sold is reversed. Not possible once the delivery is billed. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Reversing goods issue',
    input: { salesOrder },
    async preview({ salesOrder }, ctx) {
      const d = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus === 'COMPLETE', `Sales order ${salesOrder} has no goods-issued delivery.`);
      return {
        action: 'Reverse goods issue',
        businessObject: { type: 'Outbound delivery', id: d.number },
        proposedChange: `Reverse the goods issue of ${quantities(d.items)} to ${d.shipToName}.`,
        impact: 'The quantity is put back into stock and the cost-of-goods-sold posting is reversed. The delivery stays and can be goods-issued again.',
      };
    },
    async run({ salesOrder }, ctx) {
      const issued = await findDelivery(ctx, salesOrder, (x) => x.goodsIssueStatus === 'COMPLETE', `Sales order ${salesOrder} has no goods-issued delivery.`);
      const d = await ctx.gateway.reverseGoodsIssue(ctx.sap, issued.number);
      return {
        data: { summary: `The goods issue of delivery **${d.number}** was reversed. The stock is back and the delivery is waiting for goods issue again.`, delivery: d.number },
        components: [deliveryComponent(d)],
        source: { system: ctx.gateway.systemId, objectType: 'OutboundDelivery', objectId: d.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { delivery: d.number },
      };
    },
  }),

  defineTool({
    name: 'sd_cancelBillingDocument',
    domain: 'sd',
    title: 'Cancel billing document',
    description: 'Cancel a billing document (transaction VF11). SAP creates a cancellation document that reverses the receivable and the revenue. Not possible once the invoice is paid. Consequential: always requires explicit user confirmation.',
    risk: 'HIGH_IMPACT',
    operation: 'SAP_WRITE',
    statusLabel: 'Cancelling billing document',
    input: { billingDocument: billingNumber },
    async preview({ billingDocument }, ctx) {
      const b = await ctx.gateway.getBillingDocument(ctx.sap, billingDocument);
      if (b.cancelled) throw new SapError('BUSINESS_RULE', `Billing document ${billingDocument} is already cancelled.`);
      return {
        action: 'Cancel billing document',
        businessObject: { type: 'Billing document', id: b.number },
        proposedChange: `Cancel the ${fmt(b.netValue)} invoice to ${b.payerName}.`,
        impact: `The receivable on the account of ${b.payerName} and the revenue are reversed${b.salesOrder ? `, and sales order ${b.salesOrder} can be billed again` : ''}.`,
      };
    },
    async run({ billingDocument }, ctx) {
      const r = await ctx.gateway.cancelBillingDocument(ctx.sap, billingDocument);
      return {
        data: { summary: `Billing document **${r.reversedDocument}** was cancelled with cancellation document **${r.document}**.`, cancellationDocument: r.document },
        source: { system: ctx.gateway.systemId, objectType: 'BillingDocument', objectId: r.reversedDocument, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Billing document', prompt: `Show billing document ${r.reversedDocument}.` }],
        outputs: { cancellationDocument: r.document },
      };
    },
  }),

  defineTool({
    name: 'sd_createCreditMemoRequest',
    domain: 'sd',
    title: 'Create credit memo request',
    description: 'Create a credit memo request for a billing document, for example after a return or a price complaint. The credit memo itself is billed from the request later. Requires user confirmation.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Creating credit memo request',
    input: {
      billingDocument: billingNumber,
      reason: z.string().regex(/^[A-Z0-9]{3}$/).describe('SAP order reason code, e.g. 001'),
    },
    async preview({ billingDocument, reason }, ctx) {
      const b = await ctx.gateway.getBillingDocument(ctx.sap, billingDocument);
      return {
        action: 'Create credit memo request',
        businessObject: { type: 'Billing document', id: b.number },
        proposedChange: `Request a credit memo for ${b.payerName} over the full ${fmt(b.netValue)} of billing document ${b.number} (order reason ${reason}).`,
        impact: 'Only the request is created. Nothing is credited to the customer until the request is released and billed.',
      };
    },
    async run({ billingDocument, reason }, ctx) {
      const c = await ctx.gateway.createCreditMemoRequest(ctx.sap, billingDocument, reason);
      return {
        data: { summary: `Credit memo request **${c.number}** for **${c.soldToName}** over **${fmt(c.netValue)}** was created for billing document **${c.billingDocument}**.`, creditMemoRequest: c.number },
        components: [
          {
            type: 'kpi_block',
            data: {
              title: `Credit memo request ${c.number}`,
              items: [
                { label: 'Customer', value: `${c.soldToName} (${c.soldTo})`.slice(0, 60) },
                { label: 'Net value', value: fmt(c.netValue) },
                { label: 'Billing document', value: c.billingDocument },
                { label: 'Order reason', value: c.reason },
              ],
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'CreditMemoRequest', objectId: c.number, retrievedAt: now(), mock: ctx.gateway.mock },
        outputs: { creditMemoRequest: c.number },
      };
    },
  }),
];
