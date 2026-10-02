import { partnerNumber } from './line-items.js';
import { defineTool, fmt, now } from './types.js';

/** FSCM Credit Management: credit limit, exposure and risk class of a customer. */
export const creditTools = [
  defineTool({
    name: 'credit_getCreditExposure',
    domain: 'credit',
    title: 'Get credit exposure',
    description: 'Retrieve the credit limit, credit exposure, utilization and risk class of a customer. Use before releasing a credit-blocked sales order.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Checking credit exposure',
    input: { customer: partnerNumber.describe('SAP customer / business partner number, e.g. 7000000010') },
    async run({ customer }, ctx) {
      const p = await ctx.gateway.getCreditProfile(ctx.sap, customer);
      const utilization = p.limit.amount > 0 ? Math.round((p.exposure.amount / p.limit.amount) * 100) : undefined;
      const over = p.exposure.amount > p.limit.amount;
      return {
        data: {
          creditProfile: { ...p, limit: fmt(p.limit), exposure: fmt(p.exposure), utilizationPercent: utilization },
          summary:
            `**${p.customerName}** (${p.customer}) has a credit limit of **${fmt(p.limit)}** and an exposure of **${fmt(p.exposure)}**` +
            (utilization === undefined ? '' : ` (${utilization}% used)`) +
            `. ${over ? 'The exposure is **above the limit**.' : 'The exposure is within the limit.'}`,
          findings: [
            ...(over ? [`Exposure exceeds the credit limit by ${fmt({ amount: p.exposure.amount - p.limit.amount, currency: p.limit.currency })}.`] : []),
            ...(p.blocked ? ['The credit account is blocked in SAP Credit Management.'] : []),
            ...(p.exposureBasis === 'OPEN_RECEIVABLES' ? ['Exposure is the sum of open receivables; open orders and deliveries are not included.'] : []),
          ],
        },
        components: [
          {
            type: 'kpi_block',
            data: {
              title: `Credit exposure · ${p.customerName}`.slice(0, 200),
              items: [
                { label: 'Credit limit', value: fmt(p.limit) },
                { label: 'Exposure', value: fmt(p.exposure), tone: over ? 'critical' : 'neutral' },
                ...(utilization === undefined ? [] : [{ label: 'Utilization', value: `${utilization}%`, tone: over ? ('critical' as const) : utilization >= 80 ? ('warning' as const) : ('positive' as const) }]),
                ...(p.riskClass ? [{ label: 'Risk class', value: p.riskClass }] : []),
                { label: 'Credit account', value: p.blocked ? 'Blocked' : 'Not blocked', tone: p.blocked ? ('critical' as const) : ('neutral' as const) },
              ],
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'CreditAccount', objectId: `${p.customer}/${p.creditSegment}`, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Open items', prompt: `Show the open items of customer ${p.customer}.` }],
      };
    },
  }),
];
