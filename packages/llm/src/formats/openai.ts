import { ProviderError } from '../errors.js';
import type { SSEMessage } from '../sse.js';
import { safeJsonObject, type FinishReason, type LLMChunk, type LLMMessage, type ToolSpec } from '../types.js';

/**
 * OpenAI Chat Completions wire format. Used by Azure AI Foundry (Azure
 * OpenAI + model-inference endpoints) and by SAP AI Core — both its
 * foundation-model deployments and the Orchestration service, which accepts
 * the same message/tool shapes inside its module configuration.
 */

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || (m.toolCalls?.length ? null : ''),
          ...(m.toolCalls?.length && {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          }),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

export function toOpenAITools(tools: ToolSpec[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function mapOpenAIFinish(reason: string | null | undefined): FinishReason | undefined {
  switch (reason) {
    case undefined:
    case null:
      return undefined;
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: string | number };
}

/**
 * Converts OpenAI-style SSE chunks into normalized LLM chunks.
 * `unwrap` extracts the chat-completion chunk from wrapper envelopes
 * (SAP AI Core Orchestration puts it under `final_result`).
 */
export async function* fromOpenAIStream(
  provider: string,
  messages: AsyncIterable<SSEMessage>,
  unwrap: (json: Record<string, unknown>) => OpenAIStreamChunk | undefined = (j) => j as OpenAIStreamChunk,
): AsyncGenerator<LLMChunk> {
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let finish: FinishReason | undefined;
  let usageEmitted = false;

  for await (const msg of messages) {
    if (msg.data === '[DONE]') break;
    const json = safeJsonObject(msg.data);
    if (json.error || json.code) {
      const e = (json.error ?? json) as { message?: string };
      throw new ProviderError(provider, 'unavailable', `Upstream stream error: ${String(e.message ?? 'unknown').slice(0, 300)}`);
    }
    const chunk = unwrap(json);
    if (!chunk) continue;

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const entry = pending.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        pending.set(tc.index, entry);
      }
      finish = mapOpenAIFinish(choice.finish_reason) ?? finish;
    }
    if (chunk.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens)) {
      usageEmitted = true;
      yield {
        type: 'usage',
        usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 },
      };
    }
  }

  for (const [index, tc] of [...pending.entries()].sort(([a], [b]) => a - b)) {
    yield { type: 'tool_call', call: { id: tc.id || `call_${index}`, name: tc.name, arguments: safeJsonObject(tc.args) } };
  }
  if (!usageEmitted) yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  yield { type: 'finish', reason: pending.size ? 'tool_calls' : (finish ?? 'stop') };
}
