'use client';

import type {
  AgentAction,
  AttachmentRef,
  ConfirmationRequest,
  ExecutionMetadata,
  Feedback,
  MessageDTO,
  PublicError,
  SourceReference,
  StepState,
  StreamEvent,
  UIComponent,
} from '@prowess/contracts';
import { useCallback, useReducer, useRef } from 'react';
import { ApiError, api } from './api';

export interface StepView {
  id: string;
  label: string;
  state: StepState | 'pending_confirmation';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'streaming' | 'complete' | 'error' | 'stopped';
  agent?: string;
  attachments?: AttachmentRef[];
  components: UIComponent[];
  sources: SourceReference[];
  actions: AgentAction[];
  confirmations: ConfirmationRequest[];
  execution?: ExecutionMetadata;
  steps: StepView[];
  feedback?: Feedback;
  error?: PublicError;
}

interface State {
  conversationId: string | null;
  title: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  loading: boolean;
  loadError: PublicError | null;
}

type Action =
  | { type: 'reset' }
  | { type: 'loading' }
  | { type: 'loaded'; id: string; title: string; messages: ChatMessage[] }
  | { type: 'load_failed'; error: PublicError }
  | { type: 'begin'; user: ChatMessage; assistant: ChatMessage; replaceFrom?: string }
  | { type: 'event'; event: StreamEvent }
  | { type: 'fail'; error: PublicError }
  | { type: 'end' }
  | { type: 'append'; message: ChatMessage }
  | { type: 'confirmation'; confirmation: ConfirmationRequest }
  | { type: 'feedback'; id: string; rating: Feedback }
  | { type: 'title'; title: string };

const TEMP_ASSISTANT = '__streaming__';

function fromDTO(m: MessageDTO): ChatMessage {
  const r = m.response;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    status: m.status,
    ...(m.agent && { agent: m.agent }),
    ...(m.attachments && { attachments: m.attachments }),
    components: r?.components ?? [],
    sources: r?.sources ?? [],
    actions: r?.actions ?? [],
    confirmations: r?.confirmations ?? [],
    ...(r?.execution && { execution: r.execution }),
    steps: (r?.execution?.tools ?? []).map((t) => ({
      id: t.id,
      label: t.tool.replace(/^[a-z]+_/, '').replace(/([A-Z])/g, ' $1').toLowerCase().trim(),
      state: t.status === 'success' ? 'done' : t.status === 'pending_confirmation' ? 'pending_confirmation' : 'error',
    })),
    ...(m.feedback && { feedback: m.feedback }),
    ...(m.error && { error: m.error }),
  };
}

function patchStreaming(state: State, patch: (m: ChatMessage) => ChatMessage): State {
  const idx = state.messages.findLastIndex((m) => m.status === 'streaming');
  if (idx < 0) return state;
  const messages = state.messages.slice();
  messages[idx] = patch(messages[idx]!);
  return { ...state, messages };
}

function upsertStep(steps: StepView[], step: StepView): StepView[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i < 0) return [...steps, step];
  const next = steps.slice();
  next[i] = step;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return { conversationId: null, title: null, messages: [], streaming: false, loading: false, loadError: null };
    case 'loading':
      return { ...state, loading: true, loadError: null };
    case 'loaded':
      return { conversationId: action.id, title: action.title, messages: action.messages, streaming: false, loading: false, loadError: null };
    case 'load_failed':
      return { ...state, loading: false, loadError: action.error };
    case 'begin': {
      const cut = action.replaceFrom ? state.messages.findIndex((m) => m.id === action.replaceFrom) : -1;
      const base = cut >= 0 ? state.messages.slice(0, cut) : state.messages;
      return { ...state, streaming: true, messages: [...base, action.user, action.assistant] };
    }
    case 'event': {
      const e = action.event;
      switch (e.type) {
        case 'message.start': {
          const messages = state.messages.map((m) =>
            m.id === TEMP_ASSISTANT ? { ...m, id: e.messageId, agent: e.agent } : m.role === 'user' && m.id.startsWith('__user') ? { ...m, id: e.userMessageId } : m,
          );
          return { ...state, conversationId: e.conversationId, title: state.title ?? e.conversationTitle, messages };
        }
        case 'status':
          return patchStreaming(state, (m) => ({ ...m, steps: upsertStep(m.steps, e.step) }));
        case 'message.delta':
          return patchStreaming(state, (m) => ({ ...m, content: m.content + e.text }));
        case 'tool.start':
          return patchStreaming(state, (m) => ({ ...m, steps: upsertStep(m.steps, { id: e.tool.id, label: e.label, state: 'running' }) }));
        case 'tool.complete':
          return patchStreaming(state, (m) => ({
            ...m,
            steps: m.steps.map((s) => (s.id === e.tool.id ? { ...s, state: e.tool.status === 'pending_confirmation' ? 'pending_confirmation' : 'done' } : s)),
          }));
        case 'tool.error':
          return patchStreaming(state, (m) => ({ ...m, steps: m.steps.map((s) => (s.id === e.tool.id ? { ...s, state: 'error', label: `${s.label} — ${e.message}` } : s)) }));
        case 'component':
          return patchStreaming(state, (m) => ({ ...m, components: [...m.components, e.component] }));
        case 'source':
          return patchStreaming(state, (m) => ({ ...m, sources: [...m.sources, e.source] }));
        case 'confirmation.required':
          return patchStreaming(state, (m) => ({ ...m, confirmations: [...m.confirmations, e.confirmation] }));
        case 'message.complete':
          return {
            ...patchStreaming(state, (m) => ({
              ...m,
              status: e.status,
              actions: e.actions,
              execution: e.execution,
              steps: m.steps.map((s) => (s.state === 'running' ? { ...s, state: 'done' } : s)),
            })),
            streaming: false,
          };
        case 'error':
          return { ...patchStreaming(state, (m) => ({ ...m, status: 'error', error: e.error })), streaming: false };
      }
      return state;
    }
    case 'fail':
      return { ...patchStreaming(state, (m) => ({ ...m, status: 'error', error: action.error })), streaming: false };
    case 'end':
      return { ...patchStreaming(state, (m) => ({ ...m, status: 'stopped' })), streaming: false };
    case 'append':
      return { ...state, messages: [...state.messages, action.message] };
    case 'confirmation':
      return {
        ...state,
        messages: state.messages.map((m) => ({ ...m, confirmations: m.confirmations.map((c) => (c.id === action.confirmation.id ? action.confirmation : c)) })),
      };
    case 'feedback':
      return { ...state, messages: state.messages.map((m) => (m.id === action.id ? { ...m, feedback: action.rating } : m)) };
    case 'title':
      return { ...state, title: action.title };
  }
}

const initial: State = { conversationId: null, title: null, messages: [], streaming: false, loading: false, loadError: null };

export interface SendOptions {
  agent: string;
  modelTier: string;
  attachments?: AttachmentRef[];
  regenerateMessageId?: string;
}

export function useChat(onChanged: () => void) {
  const [state, dispatch] = useReducer(reducer, initial);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async (id: string) => {
    abortRef.current?.abort();
    dispatch({ type: 'loading' });
    try {
      const c = await api.conversation(id);
      dispatch({ type: 'loaded', id: c.id, title: c.title, messages: c.messages.map(fromDTO) });
    } catch (err) {
      dispatch({ type: 'load_failed', error: (err as ApiError).error });
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: 'reset' });
  }, []);

  const send = useCallback(
    async (text: string, opts: SendOptions) => {
      if (stateRef.current.streaming) return;
      const now = new Date().toISOString();
      const regenerate = opts.regenerateMessageId;
      const user: ChatMessage = {
        id: `__user${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: now,
        status: 'complete',
        ...(opts.attachments?.length && { attachments: opts.attachments }),
        components: [],
        sources: [],
        actions: [],
        confirmations: [],
        steps: [],
      };
      const assistant: ChatMessage = { id: TEMP_ASSISTANT, role: 'assistant', content: '', createdAt: now, status: 'streaming', components: [], sources: [], actions: [], confirmations: [], steps: [] };
      dispatch({ type: 'begin', user, assistant, ...(regenerate && { replaceFrom: regenerate }) });

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of api.chat(
          {
            ...(stateRef.current.conversationId && { conversationId: stateRef.current.conversationId }),
            message: text,
            agent: opts.agent,
            modelTier: opts.modelTier,
            ...(opts.attachments?.length && { attachments: opts.attachments.map((a) => a.id) }),
            ...(regenerate && { regenerateMessageId: regenerate }),
          },
          controller.signal,
        )) {
          dispatch({ type: 'event', event });
          if (event.type === 'message.start') onChanged();
        }
        if (stateRef.current.streaming) dispatch({ type: 'end' });
      } catch (err) {
        if (controller.signal.aborted) dispatch({ type: 'end' });
        else if (err instanceof ApiError) dispatch({ type: 'fail', error: err.error });
        else
          dispatch({
            type: 'fail',
            error: { code: 'STREAM_INTERRUPTED', message: 'The connection was interrupted. Your conversation is saved — try again.', correlationId: '', reference: '', retryable: true, category: 'INTERNAL' },
          });
      } finally {
        abortRef.current = null;
        onChanged();
      }
    },
    [onChanged],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const resolveConfirmation = useCallback((confirmation: ConfirmationRequest, message?: MessageDTO) => {
    dispatch({ type: 'confirmation', confirmation });
    if (message) dispatch({ type: 'append', message: fromDTO(message) });
  }, []);

  const rate = useCallback(async (messageId: string, rating: Feedback) => {
    const id = stateRef.current.conversationId;
    if (!id) return;
    dispatch({ type: 'feedback', id: messageId, rating });
    await api.feedback(id, messageId, rating).catch(() => undefined);
  }, []);

  const setTitle = useCallback((title: string) => dispatch({ type: 'title', title }), []);

  return { ...state, load, reset, send, stop, resolveConfirmation, rate, setTitle };
}
