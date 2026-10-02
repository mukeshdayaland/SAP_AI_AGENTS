import { TokenCache } from '../auth.js';
import { ProviderError } from '../errors.js';
import { gcpTokenFetcher, type GcpAuthConfig } from '../gcp/auth.js';
import { CircuitBreaker, DEFAULT_POLICY, readBody, resilientFetch, type ResiliencePolicy } from '../http.js';
import { parseSSE } from '../sse.js';
import {
  collect,
  safeJsonObject,
  type FinishReason,
  type JSONSchema,
  type LLMChunk,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ToolSpec,
} from '../types.js';

/**
 * Google Cloud Vertex AI adapter for Gemini models via
 * `…/publishers/google/models/{model}:streamGenerateContent?alt=sse`.
 */

export interface GcpVertexConfig {
  projectId: string;
  /** e.g. `europe-west3`, `us-central1`, or `global`. */
  location: string;
  auth: GcpAuthConfig;
  policy?: Partial<ResiliencePolicy>;
  fetchImpl?: typeof fetch;
}

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/** Keywords supported by Vertex `FunctionDeclaration.parameters` (OpenAPI 3 subset). */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
]);

export function toVertexSchema(schema: unknown): JSONSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const out: JSONSchema = {};
  for (const [key, value] of Object.entries(schema as JSONSchema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as JSONSchema).map(([k, v]) => [k, toVertexSchema(v)]));
    } else if (key === 'items') {
      out.items = toVertexSchema(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map(toVertexSchema);
    } else if (key === 'type' && Array.isArray(value)) {
      // JSON Schema `["string","null"]` → OpenAPI `type: string, nullable: true`
      const types = value.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (types.length !== value.length) out.nullable = true;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toVertexContents(messages: LLMMessage[]): { systemInstruction?: { parts: { text: string }[] }; contents: Content[] } {
  const system: { text: string }[] = [];
  const contents: Content[] = [];
  const push = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
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
        push('model', [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.arguments } })),
        ]);
        break;
      case 'tool':
        push('user', [{ functionResponse: { name: m.name, response: m.isError ? { error: m.content } : { content: m.content } } }]);
        break;
    }
  }
  return { ...(system.length && { systemInstruction: { parts: system } }), contents };
}

function toVertexTools(tools: ToolSpec[] | undefined) {
  if (!tools?.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toVertexSchema(t.inputSchema) })) }];
}

function mapFinish(reason: string | undefined): FinishReason | undefined {
  switch (reason) {
    case undefined:
      return undefined;
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class GcpVertexProvider implements LLMProvider {
  readonly id = 'gcp-vertex' as const;
  readonly private = false;
  private readonly tokens: TokenCache;
  private readonly breaker = new CircuitBreaker();
  private readonly policy: ResiliencePolicy;

  constructor(private readonly cfg: GcpVertexConfig) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(cfg.projectId)) {
      throw new ProviderError(this.id, 'configuration', 'GCP_PROJECT_ID is not a valid project ID');
    }
    if (!/^(global|[a-z]+-[a-z]+\d)$/.test(cfg.location)) {
      throw new ProviderError(this.id, 'configuration', `Invalid Vertex location "${cfg.location}"`);
    }
    this.policy = { ...DEFAULT_POLICY, ...cfg.policy };
    this.tokens = new TokenCache(gcpTokenFetcher(cfg.auth, cfg.fetchImpl));
  }

  private get host(): string {
    return this.cfg.location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${this.cfg.location}-aiplatform.googleapis.com`;
  }

  buildRequest(req: LLMRequest): { url: string; body: Record<string, unknown> } {
    const { systemInstruction, contents } = toVertexContents(req.messages);
    return {
      url: `${this.host}/v1/projects/${this.cfg.projectId}/locations/${this.cfg.location}/publishers/google/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      body: {
        contents,
        ...(systemInstruction && { systemInstruction }),
        ...(req.tools?.length && { tools: toVertexTools(req.tools) }),
        generationConfig: {
          ...(req.maxOutputTokens !== undefined && { maxOutputTokens: req.maxOutputTokens }),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
        },
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
          ...(req.correlationId && { 'x-goog-request-reason': `prowess:${req.correlationId}`.slice(0, 100) }),
        },
        body: JSON.stringify(body),
      },
      policy: this.policy,
      breaker: this.breaker,
      headers: async () => ({ authorization: `Bearer ${await this.tokens.get()}` }),
      ...(req.signal && { signal: req.signal }),
      ...(this.cfg.fetchImpl && { fetchImpl: this.cfg.fetchImpl }),
    });

    let finish: FinishReason | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let callIndex = 0;
    let sawToolCall = false;

    for await (const msg of parseSSE(readBody(res, this.id, this.policy.idleTimeoutMs, req.signal))) {
      const json = safeJsonObject(msg.data) as {
        candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        error?: { message?: string };
      };
      if (json.error) throw new ProviderError(this.id, 'unavailable', `Upstream stream error: ${String(json.error.message).slice(0, 300)}`);
      const candidate = json.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if ('text' in part && part.text) yield { type: 'text', text: part.text };
        if ('functionCall' in part) {
          sawToolCall = true;
          const withId = part.functionCall as { id?: string; name: string; args?: Record<string, unknown> };
          yield {
            type: 'tool_call',
            call: { id: withId.id ?? `${withId.name}_${callIndex++}`, name: withId.name, arguments: withId.args ?? {} },
          };
        }
      }
      finish = mapFinish(candidate?.finishReason) ?? finish;
      if (json.usageMetadata) {
        usage = { inputTokens: json.usageMetadata.promptTokenCount ?? 0, outputTokens: json.usageMetadata.candidatesTokenCount ?? 0 };
      }
    }
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: sawToolCall ? 'tool_calls' : (finish ?? 'stop') };
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.tokens.get();
      return this.breaker.state !== 'open';
    } catch {
      return false;
    }
  }
}
