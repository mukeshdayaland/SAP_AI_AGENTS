import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '@prowess/contracts';
import { MockProvider, type LLMProvider, type ProviderId } from '@prowess/llm';
import { createLogger } from '@prowess/observability';
import { createMcpHttpServer } from '../../sap-mcp/src/app.js';
import { MockSapGateway } from '../../sap-mcp/src/sap/mock-gateway.js';
import { BUSINESS_DOMAINS } from '../../sap-mcp/src/tools/types.js';
import { buildApp } from '../src/app.js';
import { RingBufferAuditSink } from '../src/audit/audit.js';
import { loadConfig } from '../src/config/env.js';
import { MemoryStore } from '../src/persistence/memory.js';
import { createServices } from '../src/services.js';
import type { Geocoder } from '../src/vendors/geocoder.js';

export const SECRET = 'integration-test-secret'.padEnd(48, '-');
export const USERS = {
  alex: 'alex.morgan@prowess.example', // AI_USER + AI_POWER_USER; SAP may release invoices
  jordan: 'jordan.lee@prowess.example', // AI_USER only; SAP denies releases
  sam: 'sam.rivera@prowess.example', // admin
  casey: 'casey.kim@prowess.example', // auditor only
};

const silent = createLogger({ service: 'test', level: 'error', sink: () => {} });

export async function startStack(opts: { providers?: Map<ProviderId, LLMProvider>; geocoder?: Geocoder; env?: Record<string, string> } = {}) {
  const mcpServer = createMcpHttpServer(
    {
      port: 0,
      environment: 'DEV',
      assertionSecret: SECRET,
      domains: new Set(BUSINESS_DOMAINS),
      sap: { mode: 'mock', destinationName: 'S4', systemId: 'S4-MOCK', allowTechnicalUser: false, mockLatencyMs: 0 },
      toolTimeoutMs: 5_000,
      logLevel: 'error',
    },
    { gateway: new MockSapGateway(0), logger: silent },
  );
  await new Promise<void>((r) => mcpServer.listen(0, r));
  const mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;

  const config = loadConfig({
    PROWESS_ENV: 'DEV',
    AUTH_MODE: 'dev',
    SERVICE_ASSERTION_SECRET: SECRET,
    SAP_MCP_URL: mcpUrl,
    LOG_LEVEL: 'error',
    UPLOAD_DIR: join(tmpdir(), `prowess-test-${process.pid}`),
    RATE_LIMIT_PER_MINUTE: '1000',
    ...opts.env,
  });
  const auditBuffer = new RingBufferAuditSink();
  const services = await createServices(config, {}, {
    store: new MemoryStore(),
    providers: opts.providers ?? new Map<ProviderId, LLMProvider>([['mock', new MockProvider()]]),
    logger: silent,
    auditSinks: [auditBuffer],
    ...(opts.geocoder && { geocoder: opts.geocoder }),
  });
  const app = await buildApp(services);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const request = async (method: string, path: string, user: string = USERS.alex, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-prowess-dev-user': user,
        'x-requested-with': 'prowess',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json: json as Record<string, unknown> & { error?: { code: string } }, text, headers: res.headers };
  };

  const chat = async (user: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/v1/chat`, {
      method: 'POST',
      headers: { 'x-prowess-dev-user': user, 'x-requested-with': 'prowess', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status !== 200) return { status: res.status, events: [] as StreamEvent[], body: JSON.parse(text) as { error: { code: string } } };
    const events = text
      .split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('data: '))?.slice(6))
      .filter((d): d is string => !!d)
      .map((d) => JSON.parse(d) as StreamEvent);
    return { status: 200, events, body: undefined };
  };

  return {
    base,
    services,
    auditBuffer,
    request,
    chat,
    stop: async () => {
      await app.close();
      await new Promise<void>((r) => mcpServer.close(() => r()));
    },
  };
}

export const ofType = <T extends StreamEvent['type']>(events: StreamEvent[], type: T) =>
  events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);
