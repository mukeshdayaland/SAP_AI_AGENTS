import { describeChoices, type ToolChoices } from '@prowess/contracts';
import { z } from 'zod';
import { FIORI_GUIDES, fioriUrl } from '../sap/fiori-guides.js';
import { defineTool, now } from './types.js';

/** Each agent is offered the guides of its own area only (see ToolChoices). */
const GUIDE_CHOICES: ToolChoices = {
  param: 'guide',
  intro:
    'Open a Fiori app beside the conversation and walk the user through a task in it, under their own SAP authorizations: when SAP rejected an action, no tool can make the change, or the user asks how to do it in SAP. Guides:',
  options: FIORI_GUIDES.map((g) => ({ value: g.id, domains: g.domains, text: `"${g.id}" (${g.app}) when ${g.when}` })),
};

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

  defineTool({
    name: 'shared_showFioriGuide',
    domain: 'shared',
    title: 'Guide the user in SAP Fiori',
    description: describeChoices(GUIDE_CHOICES, GUIDE_CHOICES.options),
    choices: GUIDE_CHOICES,
    risk: 'READ',
    operation: 'NONE',
    statusLabel: 'Preparing the Fiori guide',
    input: {
      guide: z.enum(FIORI_GUIDES.map((g) => g.id) as [string, ...string[]]),
      objectId: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/).optional().describe('Number of the business object, e.g. the sales order'),
    },
    async run({ guide: id, objectId }, ctx) {
      const guide = FIORI_GUIDES.find((g) => g.id === id)!;
      // Without a number the titles name the object only and the details ask for its number.
      const fill = (s: string, unnamed: string) => s.replaceAll(' {id}', ` ${objectId ?? unnamed}`).replace(/ +$/, '');
      const url = ctx.fiori && fioriUrl(guide, ctx.fiori, objectId);
      const steps = guide.steps.map((s) => ({ title: fill(s.title, ''), ...(s.detail && { detail: fill(s.detail, 'its number') }) }));
      return {
        data: {
          guide: guide.id,
          app: guide.app,
          steps: steps.map((s) => s.title),
          opensFiori: Boolean(url),
          agentCanAct: Boolean(url?.startsWith('/')),
          summary: `Guide **${guide.title}** in the Fiori app ${guide.app}${objectId ? ` for ${objectId}` : ''}: ${steps.length} steps.`,
          note: !url
            ? 'No Fiori launchpad is connected here, so the user sees the steps without the app.'
            : url.startsWith('/')
              ? 'The app is open beside the conversation. Read the page with fiori_read, then show the user each step in the page with fiori_point, fiori_type and fiori_click.'
              : 'The app is open beside the conversation, but on an address you cannot read or act in. The user follows the steps shown there; help from the step they name.',
        },
        components: [
          { type: 'fiori_guide', data: { guide: guide.id, title: guide.title, app: guide.app, ...(objectId && { objectId }), ...(url && { url }), embed: Boolean(url) && ctx.fiori!.embed, steps } },
        ],
      };
    },
  }),
];
