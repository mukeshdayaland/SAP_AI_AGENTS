import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FIORI_GUIDES, type FioriSettings } from '../src/sap/fiori-guides.js';
import { MockMailGateway } from '../src/outlook/mock-gateway.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy } from '../src/sf/policy.js';
import { buildRegistry } from '../src/tools/registry.js';
import { BUSINESS_DOMAINS } from '../src/tools/types.js';

const outlook = { gateway: new MockMailGateway(0), allowedRecipientDomains: [] as string[] };

const SECRET = 'test-secret-'.padEnd(48, 'x');
const LAUNCHPAD = 'https://s4.example.com:44300/sap/bc/ui2/flp?sap-client=100';
const tool = buildRegistry(new Set(BUSINESS_DOMAINS)).get('shared_showFioriGuide')!;

async function show(args: Record<string, unknown>, fiori?: FioriSettings) {
  const result = await tool.run(args as never, {
    sap: { principal: { sub: 'jordan.lee@prowess.example' }, correlationId: 't' } as unknown as SapCallContext,
    gateway: new MockSapGateway(0),
    sf: { gateway: new MockSfGateway(0), policy: new EntityPolicy() }, outlook,
    ...(fiori && { fiori }),
  });
  const component = UIComponentSchema.parse(result.components![0]);
  if (component.type !== 'fiori_guide') throw new Error('not a guide');
  return { data: result.data, guide: component.data };
}

describe('Fiori guides', () => {
  it('opens the app for the business object and fills the steps with its number', async () => {
    const { guide, data } = await show({ guide: 'sales-order-complete', objectId: '648' }, { launchpadUrl: LAUNCHPAD, embed: true, intents: {} });
    expect(guide.url).toBe(`${LAUNCHPAD}#SalesOrder-change?SalesOrder=648`);
    expect(guide.embed).toBe(true);
    expect(guide.steps[0]).toEqual({ title: 'Open sales order 648', detail: 'The app opens the order in change mode. If it asks for a number, enter 648 and press Enter.' });
    expect(data.opensFiori).toBe(true);
  });

  it('opens an app that takes no object at its start page', async () => {
    const { guide } = await show({ guide: 'purchase-order-change', objectId: '4200000402' }, { launchpadUrl: LAUNCHPAD, embed: false, intents: {} });
    expect(guide.url).toBe(`${LAUNCHPAD}#PurchaseOrder-manage`);
    expect(guide.embed).toBe(false);
  });

  it('uses the intent this system assigns to the app', async () => {
    const { guide } = await show({ guide: 'invoice-release' }, { launchpadUrl: LAUNCHPAD, embed: true, intents: { 'invoice-release': 'SupplierInvoice-releaseBlocked' } });
    expect(guide.url).toBe(`${LAUNCHPAD}#SupplierInvoice-releaseBlocked`);
  });

  it('shows the steps on their own when no launchpad is connected', async () => {
    const { guide, data } = await show({ guide: 'sales-order-complete' });
    expect(guide.url).toBeUndefined();
    expect(guide.embed).toBe(false);
    expect(guide.steps[0]).toEqual({ title: 'Open sales order', detail: 'The app opens the order in change mode. If it asks for a number, enter its number and press Enter.' });
    expect(data.opensFiori).toBe(false);
  });

  it('keeps every guide within the card contract', async () => {
    for (const g of FIORI_GUIDES) {
      expect(g.intent, g.id).toMatch(/^[A-Za-z]+-[A-Za-z0-9]+$/);
      await show({ guide: g.id, objectId: '1' }, { launchpadUrl: LAUNCHPAD, embed: true, intents: {} });
      await show({ guide: g.id });
    }
  });
});

describe('Fiori configuration', () => {
  const env = { SERVICE_ASSERTION_SECRET: SECRET };

  it('takes a launchpad on the workspace own address, where the agent can act in the page', async () => {
    const fiori = loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: '/sap/bc/ui2/flp?sap-client=100' }).fiori!;
    const { guide, data } = await show({ guide: 'sales-order-complete', objectId: '648' }, fiori);
    expect(guide.url).toBe('/sap/bc/ui2/flp?sap-client=100#SalesOrder-change?SalesOrder=648');
    expect(data.agentCanAct).toBe(true);
    expect((await show({ guide: 'sales-order-complete' }, { launchpadUrl: LAUNCHPAD, embed: true, intents: {} })).data.agentCanAct).toBe(false);
    // Only under /sap/: no other page of the workspace can be put into the pane.
    expect(() => loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: '/api/v1/workspace' })).toThrow(/sap/);
    expect(() => loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: '//evil.example/sap/' })).toThrow(/sap/);
  });

  it('has no launchpad unless one is configured, and embeds by default', () => {
    expect(loadConfig(env).fiori).toEqual({ embed: true, intents: {} });
    expect(loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: LAUNCHPAD, SAP_FIORI_EMBED: 'false', SAP_FIORI_INTENTS_JSON: '{"journal-entry":"AccountingDocument-display"}' }).fiori).toEqual({
      launchpadUrl: LAUNCHPAD,
      embed: false,
      intents: { 'journal-entry': 'AccountingDocument-display' },
    });
  });

  it('refuses an address that is not https and an intent that is not one', () => {
    expect(() => loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => loadConfig({ ...env, SAP_FIORI_LAUNCHPAD_URL: 'http://s4.example.com/flp' })).toThrow(/https/);
    expect(() => loadConfig({ ...env, SAP_FIORI_INTENTS_JSON: '{"journal-entry":"x?y=<script>"}' })).toThrow(/SemanticObject-action/);
    expect(() => loadConfig({ ...env, SAP_FIORI_INTENTS_JSON: 'nope' })).toThrow(/JSON/);
  });
});
