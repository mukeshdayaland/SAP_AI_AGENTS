import { decodeEventStream } from '../aws/eventstream.js';
import { signRequest, type AwsCredentials } from '../aws/sigv4.js';
import { ProviderError } from '../errors.js';
import { CircuitBreaker, DEFAULT_POLICY, readBody, resilientFetch, type ResiliencePolicy } from '../http.js';
import {
  collect,
  safeJsonObject,
  type FinishReason,
  type LLMChunk,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ToolSpec,
} from '../types.js';

/**
 * AWS Bedrock adapter using the model-agnostic Converse API
 * (`POST /model/{modelId}/converse-stream`). Works with Anthropic Claude,
 * Amazon Nova, Meta Llama, Mistral and other Converse-capable models, as
 * well as cross-region inference profiles (e.g. `eu.anthropic.claude-…`).
 *
 * Auth (`AWS_BEDROCK_AUTH`):
 * - `sigv4` (default): SigV4 with an access key pair. Prefer temporary STS
 *   credentials (with `AWS_SESSION_TOKEN`) issued via IAM Roles Anywhere or
 *   OIDC federation over long-lived IAM user keys.
 * - `api-key`: Bedrock API key sent as a bearer token (development only).
 */

export interface AwsBedrockConfig {
  region: string;
  auth: { type: 'sigv4'; credentials: () => Promise<AwsCredentials> } | { type: 'api-key'; apiKey: string };
  /** Optional Bedrock Guardrail applied to every request. */
  guardrail?: { identifier: string; version: string };
  endpoint?: string;
  policy?: Partial<ResiliencePolicy>;
  fetchImpl?: typeof fetch;
}

type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status: 'success' | 'error' } };

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export function toConverseMessages(messages: LLMMessage[]): { system: { text: string }[]; messages: ConverseMessage[] } {
  const system: { text: string }[] = [];
  const out: ConverseMessage[] = [];
  const push = (role: ConverseMessage['role'], blocks: ContentBlock[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    // Converse requires alternating roles; merge consecutive same-role turns.
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push({ text: m.content });
        break;
      case 'user':
        push('user', [{ text: m.content }]);
        break;
      case 'assistant':
        push('assistant', [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } })),
        ]);
        break;
      case 'tool':
        push('user', [
          { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }], status: m.isError ? 'error' : 'success' } },
        ]);
        break;
    }
  }
  return { system, messages: out };
}

export function toConverseTools(tools: ToolSpec[] | undefined) {
  if (!tools?.length) return undefined;
  return { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) };
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class AwsBedrockProvider implements LLMProvider {
  readonly id = 'aws-bedrock' as const;
  readonly private = false;
  private readonly breaker = new CircuitBreaker();
  private readonly policy: ResiliencePolicy;
  private readonly endpoint: string;

  constructor(private readonly cfg: AwsBedrockConfig) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(cfg.region)) {
      throw new ProviderError(this.id, 'configuration', `Invalid AWS region "${cfg.region}"`);
    }
    this.policy = { ...DEFAULT_POLICY, ...cfg.policy };
    this.endpoint = (cfg.endpoint ?? `https://bedrock-runtime.${cfg.region}.amazonaws.com`).replace(/\/+$/, '');
  }

  buildRequest(req: LLMRequest): { url: URL; body: string } {
    const { system, messages } = toConverseMessages(req.messages);
    const body = {
      messages,
      ...(system.length && { system }),
      inferenceConfig: {
        ...(req.maxOutputTokens !== undefined && { maxTokens: req.maxOutputTokens }),
        ...(req.temperature !== undefined && { temperature: req.temperature }),
      },
      ...(req.tools?.length && { toolConfig: toConverseTools(req.tools) }),
      ...(this.cfg.guardrail && {
        guardrailConfig: {
          guardrailIdentifier: this.cfg.guardrail.identifier,
          guardrailVersion: this.cfg.guardrail.version,
          streamProcessingMode: 'sync',
        },
      }),
    };
    return { url: new URL(`${this.endpoint}/model/${encodeURIComponent(req.model)}/converse-stream`), body: JSON.stringify(body) };
  }

  private async authHeaders(url: URL, body: string): Promise<Record<string, string>> {
    const base = { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream' };
    if (this.cfg.auth.type === 'api-key') return { ...base, authorization: `Bearer ${this.cfg.auth.apiKey}` };
    return signRequest({
      method: 'POST',
      url,
      headers: base,
      body,
      service: 'bedrock',
      region: this.cfg.region,
      credentials: await this.cfg.auth.credentials(),
    });
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
    const { url, body } = this.buildRequest(req);
    const res = await resilientFetch({
      provider: this.id,
      url: url.toString(),
      init: { method: 'POST', body },
      policy: this.policy,
      breaker: this.breaker,
      // Re-signed on every attempt: SigV4 signatures embed a timestamp.
      headers: () => this.authHeaders(url, body),
      ...(req.signal && { signal: req.signal }),
      ...(this.cfg.fetchImpl && { fetchImpl: this.cfg.fetchImpl }),
    });

    const decoder = new TextDecoder();
    const tools = new Map<number, { id: string; name: string; input: string }>();
    let finish: FinishReason = 'stop';

    for await (const msg of decodeEventStream(readBody(res, this.id, this.policy.idleTimeoutMs, req.signal))) {
      const payload = safeJsonObject(decoder.decode(msg.payload));
      if (msg.headers[':message-type'] === 'exception') {
        const type = String(msg.headers[':exception-type'] ?? 'exception');
        const kind = type === 'throttlingException' ? 'rate_limited' : type === 'validationException' ? 'bad_request' : 'unavailable';
        throw new ProviderError(this.id, kind, `${type}: ${String(payload.message ?? '').slice(0, 300)}`);
      }
      const index = Number(payload.contentBlockIndex ?? 0);
      switch (msg.headers[':event-type']) {
        case 'contentBlockStart': {
          const toolUse = (payload.start as { toolUse?: { toolUseId: string; name: string } } | undefined)?.toolUse;
          if (toolUse) tools.set(index, { id: toolUse.toolUseId, name: toolUse.name, input: '' });
          break;
        }
        case 'contentBlockDelta': {
          const delta = payload.delta as { text?: string; toolUse?: { input?: string } } | undefined;
          if (delta?.text) yield { type: 'text', text: delta.text };
          if (delta?.toolUse?.input) {
            const t = tools.get(index);
            if (t) t.input += delta.toolUse.input;
          }
          break;
        }
        case 'messageStop':
          finish = mapStopReason(payload.stopReason as string | undefined);
          break;
        case 'metadata': {
          const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          if (usage) yield { type: 'usage', usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
          break;
        }
      }
    }

    for (const t of [...tools.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
      yield { type: 'tool_call', call: { id: t.id, name: t.name, arguments: safeJsonObject(t.input) } };
    }
    yield { type: 'finish', reason: tools.size ? 'tool_calls' : finish };
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  /** Validates credential resolution; Bedrock runtime has no free ping endpoint. */
  async healthCheck(): Promise<boolean> {
    try {
      if (this.cfg.auth.type === 'sigv4') await this.cfg.auth.credentials();
      return this.breaker.state !== 'open';
    } catch {
      return false;
    }
  }
}
