import { readFile } from 'node:fs/promises';
import { TokenCache, fetchClientCredentialsToken } from '../auth.js';
import { ProviderError } from '../errors.js';
import { fromOpenAIStream, toOpenAIMessages, toOpenAITools } from '../formats/openai.js';
import { CircuitBreaker, DEFAULT_POLICY, readBody, resilientFetch, type ResiliencePolicy } from '../http.js';
import { parseSSE } from '../sse.js';
import { collect, type LLMChunk, type LLMProvider, type LLMRequest, type LLMResponse } from '../types.js';

/**
 * Azure AI Foundry adapter.
 *
 * API styles (`AZURE_AI_API_STYLE`):
 * - `openai-v1` (default): `{endpoint}/openai/v1/chat/completions`, model = deployment name.
 *   Works for Azure OpenAI and Foundry-deployed partner models.
 * - `openai-deployments`: classic `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`.
 * - `model-inference`: Azure AI Model Inference API `{endpoint}/models/chat/completions?api-version=…`.
 *
 * Auth (`AZURE_AI_AUTH`), strongest first:
 * - `workload-identity`: Entra ID federated credential. Reads the projected
 *   service-account token from `AZURE_FEDERATED_TOKEN_FILE` as client assertion —
 *   no long-lived secret exists anywhere.
 * - `client-secret`: Entra ID app registration with client secret (rotate via secret store).
 * - `api-key`: static key; acceptable for development only.
 */

export interface AzureAIFoundryConfig {
  endpoint: string;
  apiStyle: 'openai-v1' | 'openai-deployments' | 'model-inference';
  apiVersion?: string;
  auth:
    | { type: 'api-key'; apiKey: string }
    | { type: 'client-secret'; tenantId: string; clientId: string; clientSecret: string; scope?: string }
    | { type: 'workload-identity'; tenantId: string; clientId: string; tokenFile: string; scope?: string };
  policy?: Partial<ResiliencePolicy>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SCOPE = 'https://cognitiveservices.azure.com/.default';

export class AzureAIFoundryProvider implements LLMProvider {
  readonly id = 'azure-ai-foundry' as const;
  readonly private = false;
  private readonly tokens?: TokenCache;
  private readonly breaker = new CircuitBreaker();
  private readonly policy: ResiliencePolicy;
  private readonly endpoint: string;

  constructor(private readonly cfg: AzureAIFoundryConfig) {
    if (!/^https:\/\//.test(cfg.endpoint)) {
      throw new ProviderError(this.id, 'configuration', 'AZURE_AI_ENDPOINT must be an https URL');
    }
    this.endpoint = cfg.endpoint.replace(/\/+$/, '');
    this.policy = { ...DEFAULT_POLICY, ...cfg.policy };
    const auth = cfg.auth;
    if (auth.type !== 'api-key') {
      this.tokens = new TokenCache(() =>
        fetchClientCredentialsToken({
          provider: this.id,
          tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(auth.tenantId)}/oauth2/v2.0/token`,
          clientId: auth.clientId,
          scope: auth.scope ?? DEFAULT_SCOPE,
          clientAuth: 'body',
          ...(auth.type === 'client-secret'
            ? { clientSecret: auth.clientSecret }
            : { clientAssertion: async () => (await readFile(auth.tokenFile, 'utf8')).trim() }),
          ...(cfg.fetchImpl && { fetchImpl: cfg.fetchImpl }),
        }),
      );
    }
  }

  private async headers(): Promise<Record<string, string>> {
    if (this.cfg.auth.type === 'api-key') return { 'api-key': this.cfg.auth.apiKey };
    return { authorization: `Bearer ${await this.tokens!.get()}` };
  }

  buildRequest(req: LLMRequest): { url: string; body: Record<string, unknown> } {
    const body: Record<string, unknown> = {
      messages: toOpenAIMessages(req.messages),
      tools: toOpenAITools(req.tools),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxOutputTokens !== undefined && { max_completion_tokens: req.maxOutputTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    };
    switch (this.cfg.apiStyle) {
      case 'openai-deployments':
        return {
          url: `${this.endpoint}/openai/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${this.cfg.apiVersion ?? '2024-10-21'}`,
          body,
        };
      case 'model-inference':
        return {
          url: `${this.endpoint}/models/chat/completions?api-version=${this.cfg.apiVersion ?? '2024-05-01-preview'}`,
          body: { ...body, model: req.model },
        };
      default:
        return { url: `${this.endpoint}/openai/v1/chat/completions`, body: { ...body, model: req.model } };
    }
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
    const { url, body } = this.buildRequest(req);
    const res = await resilientFetch({
      provider: this.id,
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(req.correlationId && { 'x-ms-client-request-id': req.correlationId }),
        },
        body: JSON.stringify(body),
      },
      policy: this.policy,
      breaker: this.breaker,
      headers: () => this.headers(),
      ...(req.signal && { signal: req.signal }),
      ...(this.cfg.fetchImpl && { fetchImpl: this.cfg.fetchImpl }),
    });
    yield* fromOpenAIStream(this.id, parseSSE(readBody(res, this.id, this.policy.idleTimeoutMs, req.signal)));
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  /** Verifies credentials and endpoint reachability without spending tokens. */
  async healthCheck(): Promise<boolean> {
    const url =
      this.cfg.apiStyle === 'model-inference'
        ? `${this.endpoint}/models/info?api-version=${this.cfg.apiVersion ?? '2024-05-01-preview'}`
        : this.cfg.apiStyle === 'openai-v1'
          ? `${this.endpoint}/openai/v1/models`
          : `${this.endpoint}/openai/models?api-version=${this.cfg.apiVersion ?? '2024-10-21'}`;
    try {
      const res = await (this.cfg.fetchImpl ?? fetch)(url, { headers: await this.headers(), signal: AbortSignal.timeout(5_000) });
      return res.status < 500 && res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
