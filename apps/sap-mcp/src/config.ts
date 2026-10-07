import type { DeploymentEnvironment } from '@prowess/contracts';
import { USER_MAPPINGS, type UserMapping } from './sf/model.js';
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
  /** SuccessFactors, behind the `sf` domain. */
  sf: {
    mode: 'mock' | 'odata';
    destinationName: string;
    systemId: string;
    /** The login attribute that identifies the SuccessFactors user. */
    userMapping: UserMapping;
    /** Replaces the bundled entity allow-list of the generic query tool. */
    allowlistJson?: string;
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
  const domains = parseDomains(env.MCP_DOMAINS);
  const sfMode = env.SF_MODE === 'odata' ? 'odata' : 'mock';
  if (environment === 'PROD' && sfMode === 'mock' && domains.has('sf')) {
    // Asked for by name it is a configuration error; as part of the default set the domain is left out.
    if (env.MCP_DOMAINS) throw new Error('SF_MODE=mock is not permitted in PROD');
    domains.delete('sf');
  }
  const userMapping = (env.SF_USER_MAPPING ?? 'email') as UserMapping;
  if (!USER_MAPPINGS.includes(userMapping)) throw new Error(`SF_USER_MAPPING must be one of ${USER_MAPPINGS.join(', ')}`);
  return {
    port: Number(env.PORT ?? 4100),
    environment,
    assertionSecret,
    domains,
    sap: {
      mode,
      destinationName: env.SAP_DESTINATION ?? 'S4HANA',
      systemId: env.SAP_SYSTEM_ID ?? (mode === 'mock' ? 'S4-MOCK' : `S4-${environment}`),
      allowTechnicalUser: /^true$/i.test(env.SAP_ALLOW_TECHNICAL_USER ?? 'false'),
      mockLatencyMs: Number(env.SAP_MOCK_LATENCY_MS ?? 150),
    },
    sf: {
      mode: sfMode,
      destinationName: env.SF_DESTINATION ?? 'SF_ODATA',
      systemId: env.SF_SYSTEM_ID ?? (sfMode === 'mock' ? 'SF-MOCK' : `SF-${environment}`),
      userMapping,
      ...(env.SF_ENTITY_ALLOWLIST_JSON && { allowlistJson: env.SF_ENTITY_ALLOWLIST_JSON }),
    },
    toolTimeoutMs: Number(env.MCP_TOOL_TIMEOUT_MS ?? 25_000),
    logLevel: (env.LOG_LEVEL as McpConfig['logLevel']) ?? 'info',
  };
}
