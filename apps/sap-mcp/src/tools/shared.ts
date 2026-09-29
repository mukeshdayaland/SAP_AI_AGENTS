import { z } from 'zod';
import { defineTool, now } from './types.js';

export const sharedTools = [
  defineTool({
    name: 'shared_getUserContext',
    domain: 'shared',
    title: 'Get user context',
    description: 'Return who the current user is and which Prowess roles they hold. Prowess roles do not grant SAP authorizations.',
    risk: 'READ',
    operation: 'NONE',
    statusLabel: 'Reading user context',
    input: {},
    async run(_args, ctx) {
      const p = ctx.sap.principal;
      return {
        data: {
          user: p.name,
          roles: p.roles,
          environment: p.env,
          note: 'SAP business authorizations are evaluated by S/4HANA for every request and are independent of Prowess roles.',
        },
      };
    },
  }),

  defineTool({
    name: 'shared_getSystemInformation',
    domain: 'shared',
    title: 'Get system information',
    description: 'Return the connected SAP system ID and release.',
    risk: 'READ',
    operation: 'NONE',
    statusLabel: 'Connecting to SAP',
    input: {},
    async run(_args, ctx) {
      const info = await ctx.gateway.systemInfo();
      return { data: { ...info, summary: `Connected to **${info.systemId}** — ${info.description}.` } };
    },
  }),

  defineTool({
    name: 'shared_searchBusinessObject',
    domain: 'shared',
    title: 'Search business objects',
    description: 'Free-text search across invoices, purchase orders, suppliers and equipment the user may see.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Searching SAP',
    input: { query: z.string().trim().min(2).max(80) },
    async run({ query }, ctx) {
      const hits = await ctx.gateway.search(ctx.sap, query);
      return {
        data: { hits, summary: hits.length ? `Found ${hits.length} matching business object(s) for “${query}”.` : `No business objects match “${query}”.` },
        components: hits.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `Search results · “${query}”`,
                  columns: [
                    { key: 'type', label: 'Type' },
                    { key: 'id', label: 'ID' },
                    { key: 'title', label: 'Title' },
                    { key: 'subtitle', label: 'Details' },
                  ],
                  rows: hits.map((h) => ({ type: h.objectType, id: h.objectId, title: h.title, subtitle: h.subtitle ?? null })),
                },
              },
            ]
          : [],
        source: { system: ctx.gateway.systemId, objectType: 'Search', objectId: query, retrievedAt: now(), mock: ctx.gateway.mock },
      };
    },
  }),
];
