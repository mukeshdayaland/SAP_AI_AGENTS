import type { UIComponent } from './components.js';
import type {
  AgentAction,
  ConfirmationRequest,
  ExecutionMetadata,
  ExecutionStep,
  PublicError,
  SourceReference,
  ToolExecutionMetadata,
} from './domain.js';

/**
 * Server-Sent Event contract for `POST /api/v1/chat`.
 * The SSE `event:` field carries `type`; `data:` carries the JSON payload.
 */
export type StreamEvent =
  | {
      type: 'message.start';
      conversationId: string;
      userMessageId: string;
      messageId: string;
      agent: string;
      modelTier: string;
      correlationId: string;
      conversationTitle: string;
    }
  | { type: 'status'; step: ExecutionStep }
  | { type: 'message.delta'; text: string }
  | { type: 'tool.start'; tool: Pick<ToolExecutionMetadata, 'id' | 'agent' | 'tool' | 'system' | 'risk'>; label: string }
  | { type: 'tool.complete'; tool: ToolExecutionMetadata }
  | { type: 'tool.error'; tool: ToolExecutionMetadata; message: string }
  | { type: 'component'; component: UIComponent }
  | { type: 'source'; source: SourceReference }
  | { type: 'confirmation.required'; confirmation: ConfirmationRequest }
  | {
      type: 'message.complete';
      messageId: string;
      status: 'complete' | 'stopped';
      actions: AgentAction[];
      execution: ExecutionMetadata;
    }
  | { type: 'error'; error: PublicError };

export type StreamEventType = StreamEvent['type'];

export function encodeSSE(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
