/**
 * Provider-neutral LLM contract. Nothing outside `@prowess/llm` knows which
 * vendor served a request; the UI and the MCP layer only see these types.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  /** Must match /^[a-zA-Z0-9_-]{1,64}$/ — accepted by every supported provider. */
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface LLMRequest {
  /** Provider-specific model/deployment identifier resolved by the router. */
  model: string;
  messages: LLMMessage[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';

export type LLMChunk =
  | { type: 'text'; text: string }
  /** Emitted once per call, with fully assembled arguments. */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: FinishReason;
}

export interface LLMProvider {
  /** Stable identifier, e.g. `sap-ai-core`, `azure-ai-foundry`. */
  readonly id: ProviderId;
  /** True for providers whose inference stays inside the customer's SAP landscape/tenant. */
  readonly private: boolean;
  stream(request: LLMRequest): AsyncIterable<LLMChunk>;
  complete(request: LLMRequest): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
}

export const PROVIDER_IDS = ['mock', 'sap-ai-core', 'azure-ai-foundry', 'aws-bedrock', 'gcp-vertex'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Collects a stream into a full response. Shared by every provider's `complete`. */
export async function collect(stream: AsyncIterable<LLMChunk>): Promise<LLMResponse> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: FinishReason = 'stop';
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.text;
    else if (chunk.type === 'tool_call') toolCalls.push(chunk.call);
    else if (chunk.type === 'usage') usage = chunk.usage;
    else finishReason = chunk.reason;
  }
  return { text, toolCalls, usage, finishReason };
}

export function safeJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
