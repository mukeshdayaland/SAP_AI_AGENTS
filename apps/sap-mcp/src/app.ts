import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext, createLogger, metrics, runWithContext, type Logger } from '@prowess/observability';
import type { AssertionError} from '@prowess/security';
import { sha256Hex } from '@prowess/security';
import type { McpConfig } from './config.js';
import { MockSapGateway } from './sap/mock-gateway.js';
import type { SapGateway } from './sap/model.js';
import { ODataSapGateway } from './sap/odata-gateway.js';
import { authenticateCaller, buildMcpServer, type ServerDeps } from './server.js';
import { buildRegistry } from './tools/registry.js';

const MAX_BODY = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function createGateway(cfg: McpConfig, logger: Logger): SapGateway {
  return cfg.sap.mode === 'odata'
    ? new ODataSapGateway({ destinationName: cfg.sap.destinationName, systemId: cfg.sap.systemId, allowTechnicalUser: cfg.sap.allowTechnicalUser, logger })
    : new MockSapGateway(cfg.sap.mockLatencyMs);
}

export function createMcpHttpServer(cfg: McpConfig, overrides: { gateway?: SapGateway; logger?: Logger } = {}): Server {
  const logger = overrides.logger ?? createLogger({ service: 'prowess-sap-mcp', level: cfg.logLevel });
  const deps: ServerDeps = {
    registry: buildRegistry(cfg.domains),
    gateway: overrides.gateway ?? createGateway(cfg, logger),
    secret: cfg.assertionSecret,
    logger,
    toolTimeoutMs: cfg.toolTimeoutMs,
    usedConfirmations: new Map(),
  };
  if (cfg.sap.allowTechnicalUser) {
    logger.warn('sap.technical_user_enabled', { note: 'SAP calls without a user token run as the destination technical user' });
  }

  return createServer((req, res) => {
    const ctx = createContext({ traceparent: req.headers.traceparent as string | undefined, correlationId: req.headers['x-correlation-id'] as string | undefined });
    void runWithContext(ctx, async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
        if (req.method === 'GET' && url.pathname === '/readiness') {
          return send(res, 200, { status: 'ready', system: deps.gateway.systemId, mock: deps.gateway.mock, tools: deps.registry.size });
        }
        if (req.method === 'GET' && url.pathname === '/metrics') return send(res, 200, metrics.render(), 'text/plain; version=0.0.4');
        if (url.pathname !== '/mcp') return send(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

        let caller;
        try {
          caller = authenticateCaller(req.headers, deps.secret, sha256Hex);
        } catch (err) {
          logger.warn('mcp.auth_failed', { reason: (err as AssertionError).message });
          return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
        }

        const body = await readJson(req);
        const server = buildMcpServer(deps, caller);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        if (status >= 500) logger.error('mcp.request_failed', { error: err as Error });
        if (!res.headersSent) send(res, status, { jsonrpc: '2.0', error: { code: -32603, message: status === 500 ? 'Internal error' : (err as Error).message }, id: null });
      }
    });
  });
}
