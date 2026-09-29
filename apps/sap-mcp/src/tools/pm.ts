import { z } from 'zod';
import { defineTool, fmt, now } from './types.js';

const equipment = z
  .string()
  .regex(/^(EQ-?)?\d{4,18}$/i)
  .transform((v) => v.replace(/^EQ-?/i, ''))
  .describe('Equipment number, e.g. 20001234');

export const pmTools = [
  defineTool({
    name: 'pm_getEquipment',
    domain: 'pm',
    title: 'Get equipment',
    description: 'Retrieve an equipment master record (technical object) from SAP Plant Maintenance.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving equipment',
    input: { equipment },
    async run({ equipment }, ctx) {
      const e = await ctx.gateway.getEquipment(ctx.sap, equipment);
      return {
        data: { equipment: e, summary: `Equipment **${e.number}** — ${e.description}${e.functionalLocation ? ` at ${e.functionalLocation}` : ''}. Status: ${e.status}.` },
        components: [{ type: 'equipment', data: e }],
        source: { system: ctx.gateway.systemId, objectType: 'Equipment', objectId: e.number, retrievedAt: now(), mock: ctx.gateway.mock },
        followUps: [{ label: 'Maintenance history', prompt: `Analyze maintenance history for equipment ${e.number}.` }],
      };
    },
  }),

  defineTool({
    name: 'pm_getNotification',
    domain: 'pm',
    title: 'Get maintenance notification',
    description: 'Retrieve a maintenance notification from SAP Plant Maintenance.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving notification',
    input: { notification: z.string().regex(/^\d{8,12}$/) },
    async run({ notification }, ctx) {
      const n = await ctx.gateway.getNotification(ctx.sap, notification);
      return {
        data: { notification: n, summary: `Notification **${n.number}** (${n.type}, priority ${n.priority}): ${n.description}. Status: ${n.status}.` },
        components: [
          {
            type: 'kpi_block',
            data: {
              title: `Notification ${n.number}`,
              items: [
                { label: 'Priority', value: n.priority, tone: /high|very/i.test(n.priority) ? 'critical' : 'neutral' },
                { label: 'Status', value: n.status },
                { label: 'Reported', value: n.reportedOn },
              ],
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'MaintenanceNotification', objectId: n.number, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'pm_getWorkOrder',
    domain: 'pm',
    title: 'Get maintenance order',
    description: 'Retrieve a maintenance (work) order from SAP Plant Maintenance.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving work order',
    input: { workOrder: z.string().regex(/^\d{6,12}$/) },
    async run({ workOrder }, ctx) {
      const w = await ctx.gateway.getWorkOrder(ctx.sap, workOrder);
      return {
        data: {
          workOrder: { ...w, plannedCost: w.plannedCost && fmt(w.plannedCost) },
          summary: `Work order **${w.number}** (${w.orderType}): ${w.description}. Status ${w.status}, planned ${w.plannedStart ?? '?'} → ${w.plannedEnd ?? '?'}.`,
        },
        components: [{ type: 'work_order', data: w }],
        source: { system: ctx.gateway.systemId, objectType: 'MaintenanceOrder', objectId: w.number, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),

  defineTool({
    name: 'pm_getMaintenanceHistory',
    domain: 'pm',
    title: 'Get maintenance history',
    description: 'Retrieve the maintenance history (notifications, orders, measurements) of an equipment.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving maintenance history',
    input: { equipment },
    async run({ equipment }, ctx) {
      const [eq, events] = await Promise.all([ctx.gateway.getEquipment(ctx.sap, equipment), ctx.gateway.getMaintenanceHistory(ctx.sap, equipment)]);
      const critical = events.filter((e) => e.severity === 'critical' || e.severity === 'warning');
      return {
        data: {
          equipment: `${eq.number} ${eq.description}`,
          events: events.map((e) => `${e.date} ${e.kind} ${e.reference}: ${e.title}${e.detail ? ` — ${e.detail}` : ''}`),
          summary: `**${eq.description}** (${eq.number}) has ${events.length} maintenance events on record; ${critical.length} of them are warnings or critical.`,
          findings: critical.map((e) => `${e.date}: ${e.title}${e.detail ? ` — ${e.detail}` : ''}`),
        },
        components: [
          { type: 'equipment', data: eq },
          {
            type: 'timeline',
            data: {
              title: `Maintenance history · ${eq.number}`,
              events: events.map((e) => ({
                date: e.date,
                title: `${e.title} (${e.reference})`,
                ...(e.detail && { detail: e.detail }),
                ...(e.severity && { tone: e.severity }),
              })),
            },
          },
        ],
        source: { system: ctx.gateway.systemId, objectType: 'Equipment', objectId: eq.number, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),
];
