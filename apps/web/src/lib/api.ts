import type {
  AttachmentRef,
  ConfirmationRequest,
  ConversationDetail,
  ConversationSummary,
  MessageDTO,
  PublicError,
  StreamEvent,
  WorkspaceConfig,
} from '@prowess/contracts';
import { prefs } from './prefs';

/**
 * Browser API client. Talks only to same-origin `/api/v1/*` (the approuter
 * in production, the dev proxy locally) — never to SAP, MCP or model providers.
 */

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: PublicError,
  ) {
    super(error.message);
  }
}

function headers(json: boolean): HeadersInit {
  const devUser = prefs.devUser();
  return {
    'x-requested-with': 'prowess',
    ...(json && { 'content-type': 'application/json' }),
    ...(devUser && { 'x-prowess-dev-user': devUser }),
  };
}

const fallbackError = (status: number): PublicError => ({
  code: status === 401 ? 'UNAUTHENTICATED' : 'NETWORK',
  message: status === 401 ? 'Your session has expired. Please reload the page to sign in again.' : 'Prowess AI could not be reached. Check your connection and try again.',
  correlationId: '',
  reference: '',
  retryable: status !== 401,
  category: status === 401 ? 'AUTHENTICATION' : 'INTERNAL',
});

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(body !== undefined),
      credentials: 'same-origin',
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, fallbackError(0));
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => undefined)) as { error?: PublicError } | undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? fallbackError(res.status));
  return data as T;
}

export const api = {
  workspace: () => request<WorkspaceConfig>('GET', '/workspace'),
  conversations: () => request<ConversationSummary[]>('GET', '/conversations'),
  conversation: (id: string) => request<ConversationDetail>('GET', `/conversations/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) => request<ConversationSummary>('PATCH', `/conversations/${encodeURIComponent(id)}`, { title }),
  remove: (id: string) => request<void>('DELETE', `/conversations/${encodeURIComponent(id)}`),
  feedback: (conversationId: string, messageId: string, rating: 'up' | 'down') =>
    request<void>('POST', `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`, { rating }),
  confirm: (id: string, acknowledgeEnvironment?: string) =>
    request<{ confirmation: ConfirmationRequest; message: MessageDTO; followUp?: MessageDTO[] }>('POST', `/actions/${encodeURIComponent(id)}/confirm`, acknowledgeEnvironment ? { acknowledgeEnvironment } : {}),
  cancel: (id: string) => request<{ confirmation: ConfirmationRequest; followUp?: MessageDTO[] }>('POST', `/actions/${encodeURIComponent(id)}/cancel`, {}),
  adminOverview: () => request<Record<string, unknown>>('GET', '/admin/overview'),
  audit: () => request<{ events: Record<string, unknown>[] }>('GET', '/admin/audit'),

  async upload(file: File): Promise<AttachmentRef> {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(`${BASE}/files`, { method: 'POST', headers: headers(false), body: form, credentials: 'same-origin' }).catch(() => {
      throw new ApiError(0, fallbackError(0));
    });
    const data = (await res.json().catch(() => undefined)) as AttachmentRef & { error?: PublicError };
    if (!res.ok) throw new ApiError(res.status, data?.error ?? fallbackError(res.status));
    return data;
  },

  /**
   * POSTs a chat turn and yields Server-Sent Events as they arrive.
   * Uses fetch streaming (not EventSource) so the request is an
   * authenticated, CSRF-protected POST.
   */
  async *chat(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { ...headers(true), accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => undefined)) as { error?: PublicError } | undefined;
      throw new ApiError(res.status, data?.error ?? fallbackError(res.status));
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  },
};
