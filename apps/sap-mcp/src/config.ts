import { FIORI_ADDRESS, type DeploymentEnvironment } from '@prowess/contracts';
import { documentAiCredentials, type DocumentAiCredentials } from './outlook/document-ai.js';
import type { FioriSettings } from './sap/fiori-guides.js';
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
  /** The Fiori launchpad the guides open. Without an address the guides show their steps only. */
  fiori?: FioriSettings;
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
  /** Microsoft 365 mail and calendar over Graph, behind the `outlook` domain. */
  outlook: {
    mode: 'mock' | 'graph';
    systemId: string;
    /** Graph mode: the IAS application users sign in to, whose tokens IAS exchanges for Graph tokens. */
    ias?: { url: string; clientId: string; clientSecret: string };
    /** Time zone calendar times are shown in (Windows or IANA name). */
    timeZone: string;
    /** Recipient domains mail may be sent to. Empty: any. */
    allowedRecipientDomains: string[];
  };
  /** SAP Document AI, the OCR for scanned invoices the outlook domain reads. */
  documentAi: {
    mode: 'off' | 'mock' | 'service';
    /** Document AI client the documents are filed under. */
    clientId: string;
    credentials?: DocumentAiCredentials;
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

/**
 * The launchpad is either on the workspace's own address (a path under /sap/, forwarded to S/4HANA by the
 * approuter), where the agent can act in the page, or an https address. A guide can never hand the browser another scheme.
 */
function fioriSettings(env: Record<string, string | undefined>): FioriSettings {
  const launchpadUrl = env.SAP_FIORI_LAUNCHPAD_URL;
  if (launchpadUrl && !FIORI_ADDRESS.test(launchpadUrl)) throw new Error('SAP_FIORI_LAUNCHPAD_URL must be an https address or a path under /sap/');
  let intents: Record<string, string> = {};
  if (env.SAP_FIORI_INTENTS_JSON) {
    try {
      intents = JSON.parse(env.SAP_FIORI_INTENTS_JSON) as Record<string, string>;
    } catch {
      throw new Error('SAP_FIORI_INTENTS_JSON must be a JSON object of guide id to intent');
    }
    for (const intent of Object.values(intents)) {
      if (typeof intent !== 'string' || !/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(intent)) throw new Error('SAP_FIORI_INTENTS_JSON: an intent is written SemanticObject-action');
    }
  }
  return { ...(launchpadUrl && { launchpadUrl }), embed: !/^false$/i.test(env.SAP_FIORI_EMBED ?? 'true'), intents };
}

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
  const outlookMode = env.OUTLOOK_MODE === 'graph' ? 'graph' : 'mock';
  if (environment === 'PROD' && outlookMode === 'mock' && domains.has('outlook')) {
    if (env.MCP_DOMAINS) throw new Error('OUTLOOK_MODE=mock is not permitted in PROD');
    domains.delete('outlook');
  }
  const iasSecret = ups.IAS_CLIENT_SECRET ?? env.IAS_CLIENT_SECRET;
  if (outlookMode === 'graph' && domains.has('outlook') && !(env.IAS_URL && env.IAS_CLIENT_ID && iasSecret)) {
    throw new Error('OUTLOOK_MODE=graph needs IAS_URL, IAS_CLIENT_ID and IAS_CLIENT_SECRET (env or the prowess-secrets service)');
  }
  const allowedRecipientDomains = (env.OUTLOOK_ALLOWED_RECIPIENT_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (allowedRecipientDomains.some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw new Error('OUTLOOK_ALLOWED_RECIPIENT_DOMAINS must be a comma-separated list of domains');
  const documentAiCreds = documentAiCredentials(env.VCAP_SERVICES, ups.DOCUMENT_AI_SERVICE_KEY ?? env.DOCUMENT_AI_SERVICE_KEY);
  const documentAiMode = (env.DOCUMENT_AI_MODE ?? (documentAiCreds ? 'service' : outlookMode === 'mock' && environment !== 'PROD' ? 'mock' : 'off')) as McpConfig['documentAi']['mode'];
  if (!['off', 'mock', 'service'].includes(documentAiMode)) throw new Error('DOCUMENT_AI_MODE must be off, mock or service');
  if (documentAiMode === 'service' && !documentAiCreds) {
    throw new Error('DOCUMENT_AI_MODE=service needs a bound sap-document-information-extraction service or DOCUMENT_AI_SERVICE_KEY');
  }
  if (environment === 'PROD' && documentAiMode === 'mock') throw new Error('DOCUMENT_AI_MODE=mock is not permitted in PROD');
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
    fiori: fioriSettings(env),
    sf: {
      mode: sfMode,
      destinationName: env.SF_DESTINATION ?? 'SF_ODATA',
      systemId: env.SF_SYSTEM_ID ?? (sfMode === 'mock' ? 'SF-MOCK' : `SF-${environment}`),
      userMapping,
      ...(env.SF_ENTITY_ALLOWLIST_JSON && { allowlistJson: env.SF_ENTITY_ALLOWLIST_JSON }),
    },
    outlook: {
      mode: outlookMode,
      systemId: env.OUTLOOK_SYSTEM_ID ?? (outlookMode === 'mock' ? 'M365-MOCK' : `M365-${environment}`),
      timeZone: env.OUTLOOK_TIME_ZONE ?? 'Arab Standard Time',
      allowedRecipientDomains,
      ...(env.IAS_URL && env.IAS_CLIENT_ID && iasSecret && { ias: { url: env.IAS_URL, clientId: env.IAS_CLIENT_ID, clientSecret: iasSecret } }),
    },
    documentAi: {
      mode: documentAiMode,
      clientId: env.DOCUMENT_AI_CLIENT_ID ?? 'default',
      ...(documentAiCreds && { credentials: documentAiCreds }),
    },
    toolTimeoutMs: Number(env.MCP_TOOL_TIMEOUT_MS ?? 25_000),
    logLevel: (env.LOG_LEVEL as McpConfig['logLevel']) ?? 'info',
  };
}
