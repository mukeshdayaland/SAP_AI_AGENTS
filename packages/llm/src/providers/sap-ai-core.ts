import { TokenCache, fetchClientCredentialsToken } from '../auth.js';
import { ProviderError } from '../errors.js';
import {
  fromOpenAIStream,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIMessage,
  type OpenAIStreamChunk,
} from '../formats/openai.js';
import { CircuitBreaker, DEFAULT_POLICY, readBody, resilientFetch, type ResiliencePolicy } from '../http.js';
import { parseSSE } from '../sse.js';
import { collect, type LLMChunk, type LLMProvider, type LLMRequest, type LLMResponse } from '../types.js';

/**
 * SAP AI Core adapter.
 *
 * Two inference paths are supported, selected by `mode`:
 *
 * - `orchestration` (recommended): calls the Orchestration service
 *   (`/v2/inference/deployments/{id}/v2/completion`). One deployment gives
 *   access to every model in the SAP generative AI hub (OpenAI, Anthropic,
 *   Google, Mistral, Meta, Amazon, SAP-hosted open models) with optional
 *   SAP Data Privacy Integration masking and content filtering. `request.model`
 *   is the hub model name, e.g. `gpt-4.1`, `anthropic--claude-4-sonnet`.
 *
 * - `foundation`: calls an OpenAI-family foundation-model deployment directly
 *   (`/v2/inference/deployments/{deploymentId}/chat/completions`).
 *   `request.model` is the deployment ID.
 *
 * Authentication is OAuth2 client credentials against the AI Core service
 * instance's XSUAA. Credentials come from the `aicore` service binding
 * (VCAP_SERVICES) on BTP, or explicit configuration locally.
 */

export interface SapAiCoreConfig {
  /** XSUAA base URL from the service key (`url`); `/oauth/token` is appended. */
  authUrl: string;
  clientId: string;
  clientSecret: string;
  /** `serviceurls.AI_API_URL` from the service key. `/v2` is appended if missing. */
  apiUrl: string;
  resourceGroup: string;
  mode: 'orchestration' | 'foundation';
  orchestrationDeploymentId?: string;
  foundationApiVersion?: string;
  /** Enables SAP DPI anonymization of personal data before it reaches the model. */
  masking?: boolean;
  policy?: Partial<ResiliencePolicy>;
  fetchImpl?: typeof fetch;
}

interface AiCoreBinding {
  clientid: string;
  clientsecret: string;
  url: string;
  serviceurls: { AI_API_URL: string };
}

/** Reads the first `aicore` service binding from VCAP_SERVICES, if present. */
export function sapAiCoreBindingFromVcap(vcapJson: string | undefined): Pick<
  SapAiCoreConfig,
  'authUrl' | 'clientId' | 'clientSecret' | 'apiUrl'
> | null {
  if (!vcapJson) return null;
  try {
    const vcap = JSON.parse(vcapJson) as Record<string, { credentials: AiCoreBinding }[]>;
    const creds = vcap.aicore?.[0]?.credentials;
    if (!creds) return null;
    return { authUrl: creds.url, clientId: creds.clientid, clientSecret: creds.clientsecret, apiUrl: creds.serviceurls.AI_API_URL };
  } catch {
    return null;
  }
}

/** Neutralizes orchestration template placeholder syntax (`{{?name}}`) in untrusted text. */
export function escapeTemplateSyntax(text: string): string {
  return text.replaceAll('{{', '{​{');
}

export class SapAiCoreProvider implements LLMProvider {
  readonly id = 'sap-ai-core' as const;
  readonly private = true;
  private readonly tokens: TokenCache;
  private readonly breaker = new CircuitBreaker();
  private readonly policy: ResiliencePolicy;
  private readonly baseUrl: string;

  constructor(private readonly cfg: SapAiCoreConfig) {
    if (cfg.mode === 'orchestration' && !cfg.orchestrationDeploymentId) {
      throw new ProviderError(this.id, 'configuration', 'AICORE_ORCHESTRATION_DEPLOYMENT_ID is required in orchestration mode');
    }
    this.policy = { ...DEFAULT_POLICY, ...cfg.policy };
    this.baseUrl = cfg.apiUrl.replace(/\/+$/, '').replace(/(?<!\/v2)$/, '/v2');
    this.tokens = new TokenCache(() =>
      fetchClientCredentialsToken({
        provider: this.id,
        tokenUrl: `${cfg.authUrl.replace(/\/+$/, '')}/oauth/token`,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        clientAuth: 'basic',
        ...(cfg.fetchImpl && { fetchImpl: cfg.fetchImpl }),
      }),
    );
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokens.get()}`,
      'ai-resource-group': this.cfg.resourceGroup,
    };
  }

  buildRequest(req: LLMRequest): { url: string; body: unknown } {
    const params = {
      ...(req.maxOutputTokens !== undefined && { max_tokens: req.maxOutputTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    };
    if (this.cfg.mode === 'foundation') {
      const version = this.cfg.foundationApiVersion ?? '2024-10-21';
      return {
        url: `${this.baseUrl}/inference/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${version}`,
        body: {
          messages: toOpenAIMessages(req.messages),
          tools: toOpenAITools(req.tools),
          stream: true,
          stream_options: { include_usage: true },
          ...params,
        },
      };
    }

    const template: OpenAIMessage[] = toOpenAIMessages(req.messages).map((m) =>
      typeof m.content === 'string' ? { ...m, content: escapeTemplateSyntax(m.content) } : m,
    );
    return {
      url: `${this.baseUrl}/inference/deployments/${encodeURIComponent(this.cfg.orchestrationDeploymentId!)}/v2/completion`,
      body: {
        config: {
          modules: {
            prompt_templating: {
              prompt: { template, ...(req.tools?.length && { tools: toOpenAITools(req.tools) }) },
              model: { name: req.model, params },
            },
            ...(this.cfg.masking && {
              masking: {
                providers: [
                  {
                    type: 'sap_data_privacy_integration',
                    method: 'anonymization',
                    entities: [{ type: 'profile-person' }, { type: 'profile-email' }, { type: 'profile-phone' }],
                  },
                ],
              },
            }),
          },
          stream: { enabled: true },
        },
      },
    };
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
    const { url, body } = this.buildRequest(req);
    const res = await resilientFetch({
      provider: this.id,
      url,
      init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) },
      policy: this.policy,
      breaker: this.breaker,
      headers: () => this.headers(),
      ...(req.signal && { signal: req.signal }),
      ...(this.cfg.fetchImpl && { fetchImpl: this.cfg.fetchImpl }),
    });
    const sse = parseSSE(readBody(res, this.id, this.policy.idleTimeoutMs, req.signal));
    yield* fromOpenAIStream(
      this.id,
      sse,
      this.cfg.mode === 'orchestration'
        ? (json) => json.final_result as OpenAIStreamChunk | undefined
        : undefined,
    );
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await (this.cfg.fetchImpl ?? fetch)(`${this.baseUrl}/lm/deployments?$top=1`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
