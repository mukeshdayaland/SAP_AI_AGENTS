import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_META, TOOL_RISKS, UIComponentSchema } from '@prowess/contracts';
import { createLogger } from '@prowess/observability';
import {
  HEADERS,
  MCP_AUDIENCE,
  hashArguments,
  signAssertion,
  type ConfirmationAssertion,
  type PrincipalAssertion,
} from '@prowess/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from '../src/app.js';
import type { McpConfig } from '../src/config.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const cfg: McpConfig = {
  port: 0,
  environment: 'DEV',
  assertionSecret: SECRET,
  domains: new Set(['fico', 'mm', 'pm', 'shared']),
  sap: { mode: 'mock', destinationName: 'S4', systemId: 'S4-MOCK', allowTechnicalUser: false, mockLatencyMs: 0 },
  toolTimeoutMs: 5_000,
  logLevel: 'error',
};

let baseUrl: string;
const server = createMcpHttpServer(cfg, { gateway: new MockSapGateway(0), logger: createLogger({ service: 't', level: 'error', sink: () => {} }) });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function principal(sub = 'alex.morgan@prowess.example') {
  return signAssertion<PrincipalAssertion>(
    { typ: 'principal', sub, name: 'Alex', tenant: 't1', roles: ['AI_USER'], env: 'DEV', agent: 'fico', cid: 'PRW-TEST', aud: MCP_AUDIENCE },
    SECRET,
    60,
  );
}

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } }));
  return client;
}

describe('SAP MCP contract', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('publishes risk metadata for every tool', async () => {
    const client = await connect({ [HEADERS.principal]: principal() });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(19);
    for (const t of tools) {
      expect(TOOL_RISKS).toContain(t._meta?.[MCP_META.risk]);
      expect(t.name).toMatch(/^[a-z]+_[A-Za-z]+$/);
      expect(t.inputSchema.type).toBe('object');
    }
    const release = tools.find((t) => t.name === 'fico_releaseInvoicePaymentBlock')!;
    expect(release._meta?.[MCP_META.risk]).toBe('HIGH_IMPACT');
    expect(release.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it('returns valid UI components and mock-flagged sources', async () => {
    const client = await connect({ [HEADERS.principal]: principal() });
    const res = await client.callTool({ name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { components: unknown[]; source: { mock: boolean }; data: { summary: string } };
    expect(sc.source.mock).toBe(true);
    expect(sc.data.summary).toMatch(/blocked for payment/);
    for (const c of sc.components) expect(UIComponentSchema.safeParse(c).success).toBe(true);
    await client.close();
  });

  it('lets SAP authorization deny access independently of Prowess roles', async () => {
    const client = await connect({ [HEADERS.principal]: principal() });
    const res = await client.callTool({ name: 'fico_getInvoice', arguments: { invoiceNumber: '5100099999' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain('SAP_NOT_AUTHORIZED');
    await client.close();
  });

  it('refuses writes without a matching, unused confirmation', async () => {
    const args = { invoiceNumber: '5100012345', fiscalYear: '2026' };
    const noConfirm = await connect({ [HEADERS.principal]: principal() });
    const refused = await noConfirm.callTool({ name: 'fico_releaseInvoicePaymentBlock', arguments: args });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent)).toContain('CONFIRMATION_REQUIRED');
    await noConfirm.close();

    const confirmation = (overrides: Partial<ConfirmationAssertion> = {}) =>
      signAssertion<ConfirmationAssertion>(
        { typ: 'confirmation', act: 'act-1', sub: 'alex.morgan@prowess.example', tool: 'fico_releaseInvoicePaymentBlock', args: hashArguments(args), env: 'DEV', aud: MCP_AUDIENCE, ...overrides },
        SECRET,
        60,
      );

    const tampered = await connect({ [HEADERS.principal]: principal(), [HEADERS.confirmation]: confirmation({ args: hashArguments({ ...args, fiscalYear: '2025' }) }) });
    expect((await tampered.callTool({ name: 'fico_releaseInvoicePaymentBlock', arguments: args })).isError).toBe(true);
    await tampered.close();

    const ok = await connect({ [HEADERS.principal]: principal(), [HEADERS.confirmation]: confirmation() });
    const done = await ok.callTool({ name: 'fico_releaseInvoicePaymentBlock', arguments: args });
    expect(done.isError).toBeFalsy();
    const replay = await ok.callTool({ name: 'fico_releaseInvoicePaymentBlock', arguments: args });
    expect(JSON.stringify(replay.structuredContent)).toContain('already been used');
    await ok.close();
  });

  it('previews write actions without executing them', async () => {
    const client = await connect({ [HEADERS.principal]: principal() });
    const res = await client.callTool({ name: 'system_previewAction', arguments: { tool: 'fico_addInvoiceNote', arguments: { invoiceNumber: '5100012346', note: 'Checked' } } });
    const data = (res.structuredContent as { data: { preview: { action: string }; normalizedArguments: unknown } }).data;
    expect(data.preview.action).toBe('Add invoice note');
    expect(data.normalizedArguments).toEqual({ invoiceNumber: '5100012346', note: 'Checked' });
    await client.close();
  });
});
