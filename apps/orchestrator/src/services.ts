import { ModelRouter, createProvidersFromEnv, type LLMProvider, type ModelCatalog, type ProviderId } from '@prowess/llm';
import { createLogger, type Logger } from '@prowess/observability';
import { AgentRegistry } from './agents/registry.js';
import { AuditTrail, BtpAuditLogSink, RingBufferAuditSink, StdoutAuditSink, type AuditSink } from './audit/audit.js';
import { DevAuthenticator } from './auth/dev.js';
import type { Authenticator } from './auth/types.js';
import { XsuaaAuthenticator } from './auth/xsuaa.js';
import { loadCatalogs, type AgentCatalog, type WorkflowCatalog } from './config/catalog.js';
import { withBoundSecrets, type OrchestratorConfig } from './config/env.js';
import { ActionService } from './conversations/action-service.js';
import { ChatService } from './conversations/chat-service.js';
import { ConversationService } from './conversations/conversation-service.js';
import { FileService } from './files/file-service.js';
import { ClamAvScanner, NoopScanner, type MalwareScanner } from './files/scanner.js';
import { McpGateway } from './mcp/gateway.js';
import { MemoryStore } from './persistence/memory.js';
import { PostgresStore } from './persistence/postgres.js';
import type { Store } from './persistence/types.js';
import { ToolPolicy } from './security/tool-policy.js';
import { ConcurrencyGuard, QuotaService, RateLimiter } from './usage/limits.js';
import { CachingGeocoder, GoogleGeocoder, type Geocoder } from './vendors/geocoder.js';
import { VendorMapService } from './vendors/vendor-map-service.js';
import { WorkflowService } from './workflows/workflow-service.js';

/** Composition root: every dependency is constructed here and injected. */
export interface Services {
  config: OrchestratorConfig;
  logger: Logger;
  store: Store;
  router: ModelRouter;
  providerNotes: string[];
  mcp: McpGateway;
  agents: AgentRegistry;
  policy: ToolPolicy;
  audit: AuditTrail;
  auditBuffer: RingBufferAuditSink;
  authenticator: Authenticator;
  chat: ChatService;
  conversations: ConversationService;
  actions: ActionService;
  workflows: WorkflowService;
  files: FileService;
  vendorMap: VendorMapService;
  rateLimiter: RateLimiter;
  streams: ConcurrencyGuard;
}

export interface ServiceOverrides {
  store?: Store;
  providers?: Map<ProviderId, LLMProvider>;
  catalogs?: { models: ModelCatalog; agents: AgentCatalog; workflows?: WorkflowCatalog };
  authenticator?: Authenticator;
  logger?: Logger;
  scanner?: MalwareScanner;
  auditSinks?: AuditSink[];
  /** Replaces the Google geocoder; results are not written to the cache file. */
  geocoder?: Geocoder;
}

export async function createServices(config: OrchestratorConfig, env = process.env, overrides: ServiceOverrides = {}): Promise<Services> {
  const logger = overrides.logger ?? createLogger({ service: 'prowess-ai-orchestrator', level: config.logLevel });

  let store = overrides.store;
  if (!store) {
    if (config.persistence.mode === 'postgres') {
      const pg = new PostgresStore(config.persistence.postgresUrl!);
      await pg.migrate();
      store = pg;
    } else {
      logger.warn('persistence.memory', { note: 'Conversations are kept in memory and lost on restart (development only).' });
      store = new MemoryStore();
    }
  }

  let providers = overrides.providers;
  let providerNotes: string[] = [];
  if (!providers) {
    const result = createProvidersFromEnv(withBoundSecrets(env), { allowMock: config.llm.allowMock });
    providers = result.providers;
    providerNotes = result.notes;
  }
  if (!providers.size) throw new Error('No LLM provider is configured. See docs/llm-providers.md.');

  const catalogs = overrides.catalogs ?? loadCatalogs(config.configDir);
  const router = new ModelRouter(providers, catalogs.models, { ...(config.llm.preferredProvider && { preferredProvider: config.llm.preferredProvider }), logger });
  const agents = new AgentRegistry(catalogs.agents, router);
  const mcp = new McpGateway(config.mcpServers, config.assertionSecret, logger);
  const policy = ToolPolicy.fromEnv(env.TOOL_RISK_OVERRIDES);

  const auditBuffer = new RingBufferAuditSink();
  const sinks: AuditSink[] = overrides.auditSinks ?? [
    config.audit.sink === 'btp-auditlog' && config.audit.btp ? new BtpAuditLogSink(config.audit.btp, logger) : new StdoutAuditSink(),
  ];
  const audit = new AuditTrail([...sinks, auditBuffer]);

  const authenticator = overrides.authenticator ?? (config.auth.mode === 'xsuaa' ? XsuaaAuthenticator.fromVcap(env.VCAP_SERVICES, logger) : new DevAuthenticator());
  if (config.auth.mode === 'dev') logger.warn('auth.dev_mode', { note: 'Development authentication is active. Never use outside DEV.' });

  let scanner: MalwareScanner = overrides.scanner ?? new NoopScanner();
  if (!overrides.scanner && config.uploads.scanner === 'clamav') {
    if (!config.uploads.clamav) throw new Error('MALWARE_SCANNER=clamav requires CLAMAV_HOST');
    scanner = new ClamAvScanner(config.uploads.clamav.host, config.uploads.clamav.port);
  }
  if (config.uploads.enabled && scanner.name === 'none' && config.environment !== 'DEV') {
    throw new Error('File uploads outside DEV require a malware scanner (MALWARE_SCANNER=clamav) or UPLOADS_ENABLED=false');
  }

  const quota = new QuotaService(store, config.limits);
  const workflows = new WorkflowService({ store, mcp, agents, policy, audit, logger, config, catalog: catalogs.workflows ?? { workflows: [] } });
  const chat = new ChatService({ store, router, mcp, agents, policy, audit, quota, workflows, logger, config });

  const geocoder = overrides.geocoder
    ? new CachingGeocoder(overrides.geocoder, logger)
    : config.maps.geocodingKey
      ? new CachingGeocoder(new GoogleGeocoder(config.maps.geocodingKey), logger, config.maps.geocodeCacheFile)
      : undefined;

  return {
    config,
    logger,
    store,
    router,
    providerNotes,
    mcp,
    agents,
    policy,
    audit,
    auditBuffer,
    authenticator,
    chat,
    conversations: new ConversationService(store, audit),
    actions: new ActionService({ store, mcp, agents, audit, workflows, logger, config }),
    workflows,
    files: new FileService({ store, scanner, audit, logger, config: config.uploads }),
    vendorMap: new VendorMapService({ mcp, audit, logger, config, ...(geocoder && { geocoder }) }),
    rateLimiter: new RateLimiter(config.limits.requestsPerMinute),
    streams: new ConcurrencyGuard(config.limits.maxConcurrentStreamsPerUser),
  };
}
