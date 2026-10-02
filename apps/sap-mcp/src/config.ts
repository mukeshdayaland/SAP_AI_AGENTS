import type { DeploymentEnvironment } from '@prowess/contracts';
import { BUSINESS_DOMAINS, type Domain } from './tools/types.js';

export interface McpConfig {
  port: number;
  environment: DeploymentEnvironment;
  /** Shared with the orchestrator; used to verify principal and confirmation assertions. */
  assertionSecret: string;
  domains: Set<Domain>;
  sap: {
    mode: 'mock' | 'odata';
    destinationName: string;
    systemId: string;
    allowTechnicalUser: boolean;
    mockLatencyMs: number;
  };
  toolTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Reads credentials bound through a user-provided service (`cf cups`) named `prowess-secrets`. */
function userProvided(vcap: string | undefined): Record<string, string> {
  if (!vcap) return {};
  try {
    const services = JSON.parse(vcap) as Record<string, { name: string; credentials: Record<string, string> }[]>;
    return services['user-provided']?.find((s) => s.name === 'prowess-secrets')?.credentials ?? {};
  } catch {
    return {};
  }
}

/** The former `fico` domain was split by SAP module; deployments that still name it keep all of its tools. */
const LEGACY_DOMAINS: Record<string, Domain[]> = { fico: ['ar', 'ap', 'gl', 'credit'] };

function parseDomains(raw: string | undefined): Set<Domain> {
  const names = (raw ?? BUSINESS_DOMAINS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(names.flatMap((name) => LEGACY_DOMAINS[name] ?? [name as Domain]));
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): McpConfig {
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''));
  const ups = userProvided(env.VCAP_SERVICES);
  const environment = (env.PROWESS_ENV ?? 'DEV').toUpperCase() as DeploymentEnvironment;
  const assertionSecret = ups.SERVICE_ASSERTION_SECRET ?? env.SERVICE_ASSERTION_SECRET ?? '';
  if (assertionSecret.length < 32) {
    throw new Error('SERVICE_ASSERTION_SECRET (≥ 32 chars) must be provided via env or the prowess-secrets service');
  }
  const mode = env.SAP_MODE === 'odata' ? 'odata' : 'mock';
  if (environment === 'PROD' && mode === 'mock') {
    throw new Error('SAP_MODE=mock is not permitted in PROD');
  }
  return {
    port: Number(env.PORT ?? 4100),
    environment,
    assertionSecret,
    domains: parseDomains(env.MCP_DOMAINS),
    sap: {
      mode,
      destinationName: env.SAP_DESTINATION ?? 'S4HANA',
      systemId: env.SAP_SYSTEM_ID ?? (mode === 'mock' ? 'S4-MOCK' : `S4-${environment}`),
      allowTechnicalUser: /^true$/i.test(env.SAP_ALLOW_TECHNICAL_USER ?? 'false'),
      mockLatencyMs: Number(env.SAP_MOCK_LATENCY_MS ?? 150),
    },
    toolTimeoutMs: Number(env.MCP_TOOL_TIMEOUT_MS ?? 25_000),
    logLevel: (env.LOG_LEVEL as McpConfig['logLevel']) ?? 'info',
  };
}
