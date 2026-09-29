import { readFileSync } from 'node:fs';
import type { AwsCredentials } from './aws/sigv4.js';
import { ProviderError } from './errors.js';
import type { GcpAuthConfig } from './gcp/auth.js';
import { AwsBedrockProvider } from './providers/aws-bedrock.js';
import { AzureAIFoundryProvider, type AzureAIFoundryConfig } from './providers/azure-ai-foundry.js';
import { GcpVertexProvider } from './providers/gcp-vertex.js';
import { MockProvider } from './providers/mock.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { SapAiCoreProvider, sapAiCoreBindingFromVcap } from './providers/sap-ai-core.js';
import { PROVIDER_IDS, type LLMProvider, type ProviderId } from './types.js';

export type Env = Record<string, string | undefined>;

export interface ProviderFactoryResult {
  providers: Map<ProviderId, LLMProvider>;
  /** Human-readable configuration notes (never contain secret values). */
  notes: string[];
}

const flag = (v: string | undefined, fallback = false) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

function required(env: Env, provider: string, ...keys: string[]): string[] {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new ProviderError(provider, 'configuration', `Missing ${missing.join(', ')}`);
  return keys.map((k) => env[k]!);
}

function sapAiCore(env: Env): SapAiCoreProvider | null {
  const fromKey = env.AICORE_SERVICE_KEY ? sapAiCoreBindingFromVcap(JSON.stringify({ aicore: [{ credentials: JSON.parse(env.AICORE_SERVICE_KEY) }] })) : null;
  const binding = fromKey ?? sapAiCoreBindingFromVcap(env.VCAP_SERVICES);
  const explicit = env.AICORE_AUTH_URL && env.AICORE_CLIENT_ID && env.AICORE_CLIENT_SECRET && env.AICORE_API_URL;
  if (!binding && !explicit) return null;
  const creds = binding ?? {
    authUrl: env.AICORE_AUTH_URL!,
    clientId: env.AICORE_CLIENT_ID!,
    clientSecret: env.AICORE_CLIENT_SECRET!,
    apiUrl: env.AICORE_API_URL!,
  };
  const mode = env.AICORE_MODE === 'foundation' ? 'foundation' : 'orchestration';
  return new SapAiCoreProvider({
    ...creds,
    resourceGroup: env.AICORE_RESOURCE_GROUP ?? 'default',
    mode,
    ...(env.AICORE_ORCHESTRATION_DEPLOYMENT_ID && { orchestrationDeploymentId: env.AICORE_ORCHESTRATION_DEPLOYMENT_ID }),
    ...(env.AICORE_FOUNDATION_API_VERSION && { foundationApiVersion: env.AICORE_FOUNDATION_API_VERSION }),
    masking: flag(env.AICORE_MASKING),
  });
}

function azure(env: Env): AzureAIFoundryProvider | null {
  if (!env.AZURE_AI_ENDPOINT) return null;
  const authType = env.AZURE_AI_AUTH ?? (env.AZURE_FEDERATED_TOKEN_FILE ? 'workload-identity' : env.AZURE_CLIENT_SECRET ? 'client-secret' : 'api-key');
  let auth: AzureAIFoundryConfig['auth'];
  if (authType === 'workload-identity') {
    const [tenantId, clientId, tokenFile] = required(env, 'azure-ai-foundry', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE');
    auth = { type: 'workload-identity', tenantId: tenantId!, clientId: clientId!, tokenFile: tokenFile!, ...(env.AZURE_AI_SCOPE && { scope: env.AZURE_AI_SCOPE }) };
  } else if (authType === 'client-secret') {
    const [tenantId, clientId, clientSecret] = required(env, 'azure-ai-foundry', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET');
    auth = { type: 'client-secret', tenantId: tenantId!, clientId: clientId!, clientSecret: clientSecret!, ...(env.AZURE_AI_SCOPE && { scope: env.AZURE_AI_SCOPE }) };
  } else {
    const [apiKey] = required(env, 'azure-ai-foundry', 'AZURE_AI_API_KEY');
    auth = { type: 'api-key', apiKey: apiKey! };
  }
  const style = env.AZURE_AI_API_STYLE;
  return new AzureAIFoundryProvider({
    endpoint: env.AZURE_AI_ENDPOINT,
    apiStyle: style === 'openai-deployments' || style === 'model-inference' ? style : 'openai-v1',
    ...(env.AZURE_AI_API_VERSION && { apiVersion: env.AZURE_AI_API_VERSION }),
    auth,
  });
}

function bedrock(env: Env): AwsBedrockProvider | null {
  const region = env.AWS_BEDROCK_REGION ?? env.AWS_REGION;
  if (!region || (!env.AWS_BEARER_TOKEN_BEDROCK && !env.AWS_ACCESS_KEY_ID)) return null;
  const useApiKey = env.AWS_BEDROCK_AUTH === 'api-key' || (!env.AWS_BEDROCK_AUTH && !env.AWS_ACCESS_KEY_ID);
  return new AwsBedrockProvider({
    region,
    auth: useApiKey
      ? { type: 'api-key', apiKey: required(env, 'aws-bedrock', 'AWS_BEARER_TOKEN_BEDROCK')[0]! }
      : {
          type: 'sigv4',
          // Read lazily on every request so rotated temporary credentials are picked up.
          credentials: async (): Promise<AwsCredentials> => {
            const [accessKeyId, secretAccessKey] = required(process.env, 'aws-bedrock', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
            return { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }) };
          },
        },
    ...(env.AWS_BEDROCK_GUARDRAIL_ID && {
      guardrail: { identifier: env.AWS_BEDROCK_GUARDRAIL_ID, version: env.AWS_BEDROCK_GUARDRAIL_VERSION ?? 'DRAFT' },
    }),
  });
}

function vertex(env: Env): GcpVertexProvider | null {
  if (!env.GCP_PROJECT_ID) return null;
  let auth: GcpAuthConfig;
  const type = env.GCP_AUTH ?? (env.GCP_WIF_AUDIENCE ? 'workload-identity' : env.GCP_ACCESS_TOKEN ? 'access-token' : 'service-account');
  if (type === 'workload-identity') {
    const [audience, subjectTokenFile] = required(env, 'gcp-vertex', 'GCP_WIF_AUDIENCE', 'GCP_WIF_SUBJECT_TOKEN_FILE');
    auth = {
      type: 'workload-identity',
      audience: audience!,
      subjectTokenFile: subjectTokenFile!,
      ...(env.GCP_WIF_SERVICE_ACCOUNT && { serviceAccountEmail: env.GCP_WIF_SERVICE_ACCOUNT }),
    };
  } else if (type === 'access-token') {
    auth = { type: 'access-token', token: required(env, 'gcp-vertex', 'GCP_ACCESS_TOKEN')[0]! };
  } else {
    const keyJson = env.GCP_SERVICE_ACCOUNT_KEY ?? (env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8') : undefined);
    if (!keyJson) throw new ProviderError('gcp-vertex', 'configuration', 'Missing GCP_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS');
    auth = { type: 'service-account', keyJson };
  }
  return new GcpVertexProvider({ projectId: env.GCP_PROJECT_ID, location: env.GCP_LOCATION ?? 'europe-west3', auth });
}

function openAICompatible(env: Env): OpenAICompatibleProvider | null {
  if (!env.OPENAI_COMPAT_BASE_URL) return null;
  return new OpenAICompatibleProvider({
    baseUrl: env.OPENAI_COMPAT_BASE_URL,
    ...(env.OPENAI_COMPAT_API_KEY && { apiKey: env.OPENAI_COMPAT_API_KEY }),
    streamUsage: flag(env.OPENAI_COMPAT_STREAM_USAGE),
    ...(env.OPENAI_COMPAT_REASONING_EFFORT && { reasoningEffort: env.OPENAI_COMPAT_REASONING_EFFORT }),
    // Thinking models can take well over the default 30 s before the first byte.
    ...(Number(env.OPENAI_COMPAT_TIMEOUT_MS) > 0 && { policy: { connectTimeoutMs: Number(env.OPENAI_COMPAT_TIMEOUT_MS) } }),
  });
}

/**
 * Instantiates every provider whose configuration is present. A provider with
 * partial configuration fails fast at startup rather than at first request.
 */
export function createProvidersFromEnv(rawEnv: Env, opts: { allowMock: boolean; mockTokenDelayMs?: number }): ProviderFactoryResult {
  // Empty values (e.g. `KEY=` lines copied from .env.example) count as unset.
  const env: Env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''));
  const providers = new Map<ProviderId, LLMProvider>();
  const notes: string[] = [];
  const builders: [ProviderId, () => LLMProvider | null][] = [
    ['sap-ai-core', () => sapAiCore(env)],
    ['azure-ai-foundry', () => azure(env)],
    ['aws-bedrock', () => bedrock(env)],
    ['gcp-vertex', () => vertex(env)],
    ['openai-compatible', () => openAICompatible(env)],
  ];
  const disabled = new Set((env.LLM_DISABLED_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  for (const [id, build] of builders) {
    if (disabled.has(id)) {
      notes.push(`${id}: disabled by LLM_DISABLED_PROVIDERS`);
      continue;
    }
    const provider = build();
    if (provider) {
      providers.set(id, provider);
      notes.push(`${id}: enabled`);
    } else {
      notes.push(`${id}: not configured`);
    }
  }
  if (opts.allowMock) {
    providers.set('mock', new MockProvider({ tokenDelayMs: opts.mockTokenDelayMs ?? 12 }));
    notes.push('mock: enabled (offline development provider)');
  }
  return { providers, notes };
}

export function isProviderId(value: string | undefined): value is ProviderId {
  return !!value && (PROVIDER_IDS as readonly string[]).includes(value);
}
