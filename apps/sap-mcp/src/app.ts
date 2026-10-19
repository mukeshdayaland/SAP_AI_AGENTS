import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext, createLogger, metrics, runWithContext, type Logger } from '@prowess/observability';
import type { AssertionError} from '@prowess/security';
import { sha256Hex } from '@prowess/security';
import type { McpConfig } from './config.js';
import { MOCK_FIORI_PAGE, MOCK_FIORI_PATH } from './sap/mock-fiori.js';
import { MockSapGateway } from './sap/mock-gateway.js';
import type { SapGateway } from './sap/model.js';
import { ODataSapGateway } from './sap/odata-gateway.js';
import { authenticateCaller, buildMcpServer, type ServerDeps } from './server.js';
import { GRAPH_SCOPES, GraphMailGateway, IasGraphTokens } from './outlook/graph-gateway.js';
import { DocumentAiExtractor, MockDocumentExtractor, type DocumentExtractor } from './outlook/document-ai.js';
import { MOCK_SCANS, MockMailGateway } from './outlook/mock-gateway.js';
import type { MailGateway } from './outlook/model.js';
import { MockSfGateway } from './sf/mock-gateway.js';
import type { SfGateway } from './sf/model.js';
import { SfODataGateway } from './sf/odata-gateway.js';
import { EntityPolicy } from './sf/policy.js';
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

export function createSfGateway(cfg: McpConfig, logger: Logger): SfGateway {
  return cfg.sf.mode === 'odata'
    ? new SfODataGateway({ destinationName: cfg.sf.destinationName, systemId: cfg.sf.systemId, userMapping: cfg.sf.userMapping, logger })
    : new MockSfGateway(cfg.sap.mockLatencyMs);
}

export function createMailGateway(cfg: McpConfig, logger: Logger): MailGateway {
  const ias = cfg.outlook.ias;
  if (cfg.outlook.mode !== 'graph' || !ias) return new MockMailGateway(cfg.sap.mockLatencyMs);
  const tokens = new IasGraphTokens({ iasUrl: ias.url, clientId: ias.clientId, clientSecret: ias.clientSecret, scopes: GRAPH_SCOPES, logger });
  return new GraphMailGateway({ systemId: cfg.outlook.systemId, timeZone: cfg.outlook.timeZone, tokens, logger });
}

export function createDocumentExtractor(cfg: McpConfig, logger: Logger): DocumentExtractor | undefined {
  if (cfg.documentAi.mode === 'mock') return new MockDocumentExtractor(MOCK_SCANS);
  if (cfg.documentAi.mode === 'service' && cfg.documentAi.credentials) return new DocumentAiExtractor({ credentials: cfg.documentAi.credentials, clientId: cfg.documentAi.clientId, logger });
  return undefined;
}

export function createMcpHttpServer(cfg: McpConfig, overrides: { gateway?: SapGateway; sfGateway?: SfGateway; mailGateway?: MailGateway; logger?: Logger } = {}): Server {
  const logger = overrides.logger ?? createLogger({ service: 'prowess-sap-mcp', level: cfg.logLevel });
  const deps: ServerDeps = {
    registry: buildRegistry(cfg.domains),
    gateway: overrides.gateway ?? createGateway(cfg, logger),
    sf: { gateway: overrides.sfGateway ?? createSfGateway(cfg, logger), policy: EntityPolicy.fromJson(cfg.sf.allowlistJson) },
    outlook: (() => {
      const documents = createDocumentExtractor(cfg, logger);
      return { gateway: overrides.mailGateway ?? createMailGateway(cfg, logger), allowedRecipientDomains: cfg.outlook.allowedRecipientDomains, ...(documents && { documents }) };
    })(),
    ...(cfg.fiori && { fiori: cfg.fiori }),
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
          return send(res, 200, {
            status: 'ready',
            system: deps.gateway.systemId,
            mock: deps.gateway.mock,
            ...(cfg.domains.has('sf') && { successFactors: { system: deps.sf.gateway.systemId, mock: deps.sf.gateway.mock } }),
            ...(cfg.domains.has('outlook') && { outlook: { system: deps.outlook.gateway.systemId, mock: deps.outlook.gateway.mock, documentAi: cfg.documentAi.mode } }),
            tools: deps.registry.size,
          });
        }
        if (req.method === 'GET' && url.pathname === '/metrics') return send(res, 200, metrics.render(), 'text/plain; version=0.0.4');
        // In mock mode this service also stands in for the Fiori launchpad the guides open.
        if (req.method === 'GET' && cfg.sap.mode === 'mock' && url.pathname === MOCK_FIORI_PATH) return send(res, 200, MOCK_FIORI_PAGE, 'text/html; charset=utf-8');
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
