import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS, type DeploymentEnvironment } from '@prowess/contracts';
import { isProviderId, type ProviderId } from '@prowess/llm';
import { z } from 'zod';

/**
 * Orchestrator configuration. Secrets are read from environment variables
 * or, on BTP, from a user-provided service instance named `prowess-secrets`
 * (merged in below) — never from files in the repository.
 */

export interface McpServerConfig {
  id: string;
  url: string;
}

export interface OrchestratorConfig {
  port: number;
  environment: DeploymentEnvironment;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: { mode: 'dev' | 'xsuaa' };
  assertionSecret: string;
  mcpServers: McpServerConfig[];
  llm: {
    preferredProvider?: ProviderId;
    allowMock: boolean;
    maxToolRounds: number;
    requestTimeoutMs: number;
  };
  persistence: { mode: 'memory' | 'postgres'; postgresUrl?: string };
  retentionDays: number;
  limits: {
    requestsPerMinute: number;
    dailyTokensPerUser: number;
    dailyTokensPerAgent: number;
    maxConcurrentStreamsPerUser: number;
  };
  uploads: {
    enabled: boolean;
    maxBytes: number;
    allowedTypes: string[];
    dir: string;
    retentionHours: number;
    scanner: 'none' | 'clamav';
    clamav?: { host: string; port: number };
  };
  confirmations: { ttlSeconds: number };
  configDir: string;
  audit: { sink: 'stdout' | 'btp-auditlog'; btp?: { url: string; tokenUrl: string; clientId: string; clientSecret: string } };
  cors: { allowedOrigins: string[] };
}

type Env = Record<string, string | undefined>;

/** Flattens `prowess-secrets` user-provided service credentials into an env-like view. */
export function withBoundSecrets(rawEnv: Env): Env {
  // Empty values (e.g. `KEY=` lines copied from .env.example) count as unset.
  const env: Env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''));
  if (!env.VCAP_SERVICES) return env;
  try {
    const services = JSON.parse(env.VCAP_SERVICES) as Record<string, { name: string; credentials: Record<string, unknown> }[]>;
    const creds = services['user-provided']?.find((s) => s.name === 'prowess-secrets')?.credentials ?? {};
    const flat = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return { ...env, ...flat };
  } catch {
    return env;
  }
}

function postgresFromVcap(vcap: string | undefined): string | undefined {
  if (!vcap) return undefined;
  try {
    const services = JSON.parse(vcap) as Record<string, { credentials: { uri?: string } }[]>;
    return (services['postgresql-db'] ?? services.postgresql)?.[0]?.credentials.uri;
  } catch {
    return undefined;
  }
}

function auditLogFromVcap(vcap: string | undefined): OrchestratorConfig['audit']['btp'] | undefined {
  if (!vcap) return undefined;
  try {
    const services = JSON.parse(vcap) as Record<string, { credentials: { url: string; uaa: { url: string; clientid: string; clientsecret: string } } }[]>;
    const c = services.auditlog?.[0]?.credentials;
    return c && { url: c.url, tokenUrl: `${c.uaa.url}/oauth/token`, clientId: c.uaa.clientid, clientSecret: c.uaa.clientsecret };
  } catch {
    return undefined;
  }
}

const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export function defaultConfigDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/config → ../../config in dev; dist/ → ./config when bundled.
  for (const candidate of [resolve(here, '../../config'), resolve(here, 'config'), resolve(process.cwd(), 'config')]) {
    try {
      readFileSync(resolve(candidate, 'agents.json'));
      return candidate;
    } catch {
      /* try next */
    }
  }
  return resolve(process.cwd(), 'config');
}

const McpServersSchema = z.array(z.object({ id: z.string().min(1), url: z.string().url() })).min(1);

export function loadConfig(rawEnv: Env = process.env): OrchestratorConfig {
  const env = withBoundSecrets(rawEnv);
  const environment = (env.PROWESS_ENV ?? 'DEV').toUpperCase() as DeploymentEnvironment;
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`PROWESS_ENV must be one of ${ENVIRONMENTS.join(', ')}`);

  const authMode = env.AUTH_MODE === 'xsuaa' ? 'xsuaa' : 'dev';
  if (authMode === 'dev' && environment !== 'DEV') {
    throw new Error('AUTH_MODE=dev is only permitted when PROWESS_ENV=DEV');
  }

  const assertionSecret = env.SERVICE_ASSERTION_SECRET ?? '';
  if (assertionSecret.length < 32) throw new Error('SERVICE_ASSERTION_SECRET must be at least 32 characters');

  const mcpServers = McpServersSchema.parse(
    env.MCP_SERVERS ? JSON.parse(env.MCP_SERVERS) : [{ id: 'sap', url: env.SAP_MCP_URL ?? 'http://localhost:4100/mcp' }],
  );

  const preferred = env.DEFAULT_LLM_PROVIDER;
  if (preferred && !isProviderId(preferred)) throw new Error(`DEFAULT_LLM_PROVIDER "${preferred}" is not a known provider`);

  const allowMock = bool(env.LLM_ALLOW_MOCK, environment === 'DEV');
  if (allowMock && environment === 'PROD') throw new Error('LLM_ALLOW_MOCK is not permitted in PROD');

  const postgresUrl = env.DATABASE_URL ?? postgresFromVcap(env.VCAP_SERVICES);
  const persistenceMode = env.PERSISTENCE === 'postgres' || (!env.PERSISTENCE && postgresUrl) ? 'postgres' : 'memory';
  if (persistenceMode === 'postgres' && !postgresUrl) throw new Error('PERSISTENCE=postgres requires DATABASE_URL or a bound postgresql-db service');
  if (persistenceMode === 'memory' && environment === 'PROD') throw new Error('In-memory persistence is not permitted in PROD');

  const btpAudit = auditLogFromVcap(env.VCAP_SERVICES);

  return {
    port: int(env.PORT, 4000),
    environment,
    logLevel: (env.LOG_LEVEL as OrchestratorConfig['logLevel']) ?? 'info',
    auth: { mode: authMode },
    assertionSecret,
    mcpServers,
    llm: {
      ...(preferred && { preferredProvider: preferred as ProviderId }),
      allowMock,
      maxToolRounds: int(env.LLM_MAX_TOOL_ROUNDS, 5),
      requestTimeoutMs: int(env.LLM_REQUEST_TIMEOUT_MS, 120_000),
    },
    persistence: { mode: persistenceMode, ...(postgresUrl && { postgresUrl }) },
    retentionDays: int(env.CONVERSATION_RETENTION_DAYS, 90),
    limits: {
      requestsPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 30),
      dailyTokensPerUser: int(env.DAILY_TOKENS_PER_USER, 400_000),
      dailyTokensPerAgent: int(env.DAILY_TOKENS_PER_AGENT, 20_000_000),
      maxConcurrentStreamsPerUser: int(env.MAX_CONCURRENT_STREAMS_PER_USER, 2),
    },
    uploads: {
      enabled: bool(env.UPLOADS_ENABLED, true),
      maxBytes: int(env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
      allowedTypes: (env.UPLOAD_ALLOWED_TYPES ?? 'pdf,docx,xlsx,csv,txt,png,jpg').split(',').map((s) => s.trim().toLowerCase()),
      dir: env.UPLOAD_DIR ?? resolve(process.cwd(), '.uploads'),
      retentionHours: int(env.UPLOAD_RETENTION_HOURS, 24),
      scanner: env.MALWARE_SCANNER === 'clamav' ? 'clamav' : 'none',
      ...(env.CLAMAV_HOST && { clamav: { host: env.CLAMAV_HOST, port: int(env.CLAMAV_PORT, 3310) } }),
    },
    confirmations: { ttlSeconds: int(env.CONFIRMATION_TTL_SECONDS, 600) },
    configDir: env.PROWESS_CONFIG_DIR ?? defaultConfigDir(),
    audit: { sink: btpAudit ? 'btp-auditlog' : 'stdout', ...(btpAudit && { btp: btpAudit }) },
    cors: { allowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
  };
}
