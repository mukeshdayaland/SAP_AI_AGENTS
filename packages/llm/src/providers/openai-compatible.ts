import { ProviderError } from '../errors.js';
import { fromOpenAIStream, toOpenAIMessages, toOpenAITools } from '../formats/openai.js';
import { CircuitBreaker, DEFAULT_POLICY, readBody, resilientFetch, type ResiliencePolicy } from '../http.js';
import { parseSSE } from '../sse.js';
import { collect, type LLMChunk, type LLMProvider, type LLMRequest, type LLMResponse } from '../types.js';

/**
 * Generic OpenAI Chat Completions adapter for any `{baseUrl}/chat/completions`
 * endpoint with bearer-key auth — Mistral, Groq, Cerebras, OpenRouter, NVIDIA
 * NIM, GitHub Models and most hosted open-model APIs.
 *
 * Sends only fields every such API accepts: `max_tokens` (not
 * `max_completion_tokens`) and, unless `streamUsage` is set, no
 * `stream_options` — strict APIs such as Mistral reject unknown fields and
 * report usage in the final chunk on their own.
 */

export interface OpenAICompatibleConfig {
  /** Base URL up to and including the version segment, e.g. `https://api.mistral.ai/v1`. */
  baseUrl: string;
  /** Omit for anonymous endpoints. */
  apiKey?: string;
  /** Send `stream_options.include_usage` (OpenAI, Gemini, Groq, OpenRouter). */
  streamUsage?: boolean;
  /** `reasoning_effort` for thinking models (Gemini: minimal | low | medium | high). Omitted when unset. */
  reasoningEffort?: string;
  policy?: Partial<ResiliencePolicy>;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible' as const;
  readonly private = false;
  private readonly breaker = new CircuitBreaker();
  private readonly policy: ResiliencePolicy;
  private readonly baseUrl: string;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    if (!/^https:\/\//.test(cfg.baseUrl)) {
      throw new ProviderError(this.id, 'configuration', 'OPENAI_COMPAT_BASE_URL must be an https URL');
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.policy = { ...DEFAULT_POLICY, ...cfg.policy };
  }

  private async headers(): Promise<Record<string, string>> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  buildRequest(req: LLMRequest): { url: string; body: Record<string, unknown> } {
    return {
      url: `${this.baseUrl}/chat/completions`,
      body: {
        model: req.model,
        messages: toOpenAIMessages(req.messages, { echoProviderMetadata: true }),
        tools: toOpenAITools(req.tools),
        stream: true,
        ...(this.cfg.streamUsage && { stream_options: { include_usage: true } }),
        ...(this.cfg.reasoningEffort && { reasoning_effort: this.cfg.reasoningEffort }),
        ...(req.maxOutputTokens !== undefined && { max_tokens: req.maxOutputTokens }),
        ...(req.temperature !== undefined && { temperature: req.temperature }),
      },
    };
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
          ...(req.correlationId && { 'x-request-id': req.correlationId }),
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
    try {
      const res = await (this.cfg.fetchImpl ?? fetch)(`${this.baseUrl}/models`, { headers: await this.headers(), signal: AbortSignal.timeout(5_000) });
      return res.status < 500 && res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
