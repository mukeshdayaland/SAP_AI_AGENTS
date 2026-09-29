import {
  parseUIComponent,
  type AgentAction,
  type ChatRequest,
  type ConfirmationRequest,
  type ExecutionMetadata,
  type SourceReference,
  type StreamEvent,
  type ToolExecutionMetadata,
  type UIComponent,
} from '@prowess/contracts';
import type { LLMMessage, ModelRouter, RoutedSelection, ToolCall, ToolSpec } from '@prowess/llm';
import { currentContext, enrichContext, M, type Logger } from '@prowess/observability';
import { detectInjectionMarkers, fenceUntrusted, hashArguments } from '@prowess/security';
import type { AgentRegistry } from '../agents/registry.js';
import type { AuditTrail } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import type { AgentDefinition } from '../config/catalog.js';
import type { OrchestratorConfig } from '../config/env.js';
import { AppError, toAppError, toPublicError } from '../errors/app-error.js';
import { buildContext, systemPrompt, updateSummary, withAttachments } from '../llm/context.js';
import type { McpGateway, McpSession, McpToolInfo } from '../mcp/gateway.js';
import type { ConversationRecord, MessageRecord, Owner, PendingActionRecord, Store } from '../persistence/types.js';
import type { ToolPolicy } from '../security/tool-policy.js';
import { today, type QuotaService } from '../usage/limits.js';
import { newId, titleFrom, toConfirmation } from './mappers.js';

export interface ChatDeps {
  store: Store;
  router: ModelRouter;
  mcp: McpGateway;
  agents: AgentRegistry;
  policy: ToolPolicy;
  audit: AuditTrail;
  quota: QuotaService;
  logger: Logger;
  config: OrchestratorConfig;
}

/** A validated, persisted turn ready to stream. Produced by `prepare`, consumed by `execute`. */
export interface PreparedTurn {
  auth: AuthContext;
  owner: Owner;
  conversation: ConversationRecord;
  agent: AgentDefinition;
  tier: string;
  history: MessageRecord[];
  userMessage: MessageRecord;
  userTurn: string;
  assistantMessageId: string;
  correlationId: string;
}

export type Emit = (event: StreamEvent) => void;

const MAX_FOLLOW_UPS = 4;

interface TurnState {
  text: string;
  components: UIComponent[];
  sources: SourceReference[];
  followUps: AgentAction[];
  confirmations: ConfirmationRequest[];
  tools: ToolExecutionMetadata[];
  toolContext: string[];
  usage: { inputTokens: number; outputTokens: number };
  selection?: RoutedSelection;
}

export class ChatService {
  constructor(private readonly deps: ChatDeps) {}

  /**
   * Validates and persists the user's turn. Throws AppError for anything the
   * client must fix (authorization, quota, unknown IDs) *before* streaming
   * starts, so those surface as proper HTTP errors.
   */
  async prepare(auth: AuthContext, req: ChatRequest): Promise<PreparedTurn> {
    const { store, agents, quota, audit } = this.deps;
    const user = auth.user;
    const owner: Owner = { userId: user.id, tenantId: user.tenantId };
    const correlationId = currentContext()?.correlationId ?? newId('t');

    let conversation = req.conversationId ? await store.conversations.get(owner, req.conversationId) : null;
    if (req.conversationId && !conversation) throw AppError.notFound('Conversation');

    const agent = agents.resolve(user, req.agent ?? conversation?.agent);
    const keepTier = conversation && agents.tiersFor(user, agent).includes(conversation.modelTier) ? conversation.modelTier : undefined;
    const tier = agents.resolveTier(user, agent, req.modelTier ?? keepTier);
    await quota.assertWithinQuota(user.id, agent.id);
    enrichContext({ agent: agent.id });

    const now = new Date().toISOString();
    if (!conversation) {
      conversation = { id: newId('c'), ...owner, title: titleFrom(req.message), agent: agent.id, modelTier: tier, createdAt: now, updatedAt: now };
      await store.conversations.create(conversation);
      audit.record({ type: 'CONVERSATION_CREATED', ...owner, agent: agent.id, status: 'success', details: { conversationId: conversation.id } });
    }

    let history = await store.messages.list(conversation.id);
    let content = req.message;
    let attachmentIds = req.attachments ?? [];

    if (req.regenerateMessageId) {
      const target = history.find((m) => m.id === req.regenerateMessageId && m.role === 'user');
      if (!target) throw AppError.notFound('Message');
      content = target.content;
      attachmentIds = target.attachments?.map((a) => a.id) ?? [];
      await store.messages.deleteFrom(conversation.id, target.createdAt);
      history = history.filter((m) => m.createdAt < target.createdAt);
    }

    const attachments = await Promise.all(
      attachmentIds.map(async (id) => {
        const a = await store.attachments.get(owner, id);
        if (!a) throw AppError.validation('An attachment is missing or has expired. Please upload it again.');
        return a;
      }),
    );

    const userMessage: MessageRecord = {
      id: newId('m'),
      conversationId: conversation.id,
      role: 'user',
      content,
      createdAt: now,
      status: 'complete',
      ...(attachments.length && { attachments: attachments.map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes })) }),
    };
    await store.messages.add(userMessage);
    audit.record({ type: 'AGENT_INVOKED', ...owner, agent: agent.id, status: 'success', details: { conversationId: conversation.id, modelTier: tier } });

    return {
      auth,
      owner,
      conversation,
      agent,
      tier,
      history,
      userMessage,
      userTurn: withAttachments(content, attachments.map((a) => ({ fileName: a.fileName, ...(a.extractedText && { text: a.extractedText }) }))),
      assistantMessageId: newId('m'),
      correlationId,
    };
  }

  /** Runs the agent loop and streams events. Never throws; failures become `error` events. */
  async execute(turn: PreparedTurn, emit: Emit, signal: AbortSignal): Promise<void> {
    const { store, router, mcp, agents, config, logger } = this.deps;
    const started = Date.now();
    const state: TurnState = { text: '', components: [], sources: [], followUps: [], confirmations: [], tools: [], toolContext: [], usage: { inputTokens: 0, outputTokens: 0 } };
    let status: 'complete' | 'stopped' = 'complete';
    let session: McpSession | undefined;

    emit({
      type: 'message.start',
      conversationId: turn.conversation.id,
      conversationTitle: turn.conversation.title,
      userMessageId: turn.userMessage.id,
      messageId: turn.assistantMessageId,
      agent: turn.agent.id,
      modelTier: turn.tier,
      correlationId: turn.correlationId,
    });
    emit({ type: 'status', step: { id: 'understand', label: 'Understanding request', state: 'running' } });

    try {
      let allTools: McpToolInfo[] = [];
      try {
        allTools = await mcp.listTools(config.environment);
      } catch (err) {
        logger.warn('chat.tools_unavailable', { error: (err as Error).message });
      }
      const agentTools = agents.toolsFor(turn.agent, allTools);
      const toolSpecs: ToolSpec[] = agentTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      if (!allTools.length && turn.agent.allowedTools.length) {
        emit({ type: 'status', step: { id: 'tools', label: 'SAP tools are temporarily unavailable', state: 'skipped' } });
      }

      const tier = router.tier(turn.tier)!;
      const context = buildContext({
        system: systemPrompt(turn.agent, config.environment, turn.auth.user.displayName),
        conversation: turn.conversation,
        history: turn.history,
        userTurn: turn.userTurn,
        budget: { maxContextTokens: tier.maxContextTokens, reservedOutputTokens: tier.maxOutputTokens },
      });
      const messages: LLMMessage[] = context.messages;

      session = mcp.session({
        user: turn.auth.user,
        agent: turn.agent.id,
        environment: config.environment,
        correlationId: turn.correlationId,
        ...(turn.auth.token && { userToken: turn.auth.token }),
      });

      const llmSignal = AbortSignal.any([signal, AbortSignal.timeout(config.llm.requestTimeoutMs)]);
      for (let round = 0; round <= config.llm.maxToolRounds; round++) {
        const offerTools = round < config.llm.maxToolRounds && toolSpecs.length ? toolSpecs : undefined;
        const calls: ToolCall[] = [];
        let roundText = '';
        const stream = router.stream(
          turn.tier,
          { messages, ...(offerTools && { tools: offerTools }), signal: llmSignal, correlationId: turn.correlationId },
          (selection) => {
            state.selection = selection;
            enrichContext({ provider: selection.provider });
          },
        );
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            if (!roundText && state.text) {
              state.text += '\n\n';
              emit({ type: 'message.delta', text: '\n\n' });
            }
            roundText += chunk.text;
            state.text += chunk.text;
            emit({ type: 'message.delta', text: chunk.text });
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk.call);
          } else if (chunk.type === 'usage') {
            state.usage.inputTokens += chunk.usage.inputTokens;
            state.usage.outputTokens += chunk.usage.outputTokens;
          }
        }
        if (round === 0) emit({ type: 'status', step: { id: 'understand', label: 'Understanding request', state: 'done' } });
        if (signal.aborted) {
          status = 'stopped';
          break;
        }
        if (!calls.length) break;

        messages.push({ role: 'assistant', content: roundText, toolCalls: calls });
        for (const call of calls) {
          if (signal.aborted) break;
          const result = await this.runToolCall(turn, call, agentTools, allTools, session, state, emit, signal);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content, ...(result.isError && { isError: true }) });
        }
        emit({ type: 'status', step: { id: `compose-${round}`, label: 'Preparing response', state: 'running' } });
      }
      if (signal.aborted) status = 'stopped';

      if (!state.text.trim() && status === 'complete') {
        state.text = state.components.length ? 'Here is what I found.' : "I wasn't able to produce an answer for that. Please rephrase or try again.";
        emit({ type: 'message.delta', text: state.text });
      }

      const execution = this.execution(turn, state, started);
      await store.messages.add({
        id: turn.assistantMessageId,
        conversationId: turn.conversation.id,
        role: 'assistant',
        content: state.text,
        agent: turn.agent.id,
        modelTier: turn.tier,
        ...(state.selection && { provider: state.selection.provider, model: state.selection.model }),
        createdAt: new Date().toISOString(),
        status,
        response: {
          ...(state.components.length && { components: state.components }),
          ...(state.sources.length && { sources: state.sources }),
          ...(state.followUps.length && { actions: state.followUps }),
          ...(state.confirmations.length && { confirmations: state.confirmations }),
          execution,
        },
        ...(state.toolContext.length && { toolContext: fenceUntrusted('sap_data', state.toolContext.join('\n'), 6_000) }),
      });
      await store.conversations.update(turn.owner, turn.conversation.id, { updatedAt: new Date().toISOString(), agent: turn.agent.id, modelTier: turn.tier });
      emit({ type: 'message.complete', messageId: turn.assistantMessageId, status, actions: state.followUps, execution: this.publicExecution(turn, execution) });

      void updateSummary({ store, router, tier: turn.tier, conversation: turn.conversation, overflow: context.overflow, logger });
    } catch (err) {
      const aborted = signal.aborted;
      const appError = aborted ? new AppError('STOPPED', 'Generation stopped.', 'VALIDATION') : toAppError(err);
      if (!aborted) logger.error('chat.turn_failed', { code: appError.code, error: (appError.internal ?? err) as Error });
      const publicError = toPublicError(appError);
      await store.messages
        .add({
          id: turn.assistantMessageId,
          conversationId: turn.conversation.id,
          role: 'assistant',
          content: state.text,
          agent: turn.agent.id,
          modelTier: turn.tier,
          createdAt: new Date().toISOString(),
          status: aborted ? 'stopped' : 'error',
          ...(!aborted && { error: publicError }),
          response: { execution: this.execution(turn, state, started) },
        })
        .catch((e: Error) => logger.error('chat.persist_failed', { error: e }));
      if (aborted) {
        emit({ type: 'message.complete', messageId: turn.assistantMessageId, status: 'stopped', actions: [], execution: this.publicExecution(turn, this.execution(turn, state, started)) });
      } else {
        emit({ type: 'error', error: publicError });
      }
    } finally {
      await session?.close();
      await this.recordUsage(turn, state, started);
    }
  }

  private async runToolCall(
    turn: PreparedTurn,
    call: ToolCall,
    agentTools: McpToolInfo[],
    allTools: McpToolInfo[],
    session: McpSession,
    state: TurnState,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<{ content: string; isError?: boolean }> {
    const { audit, policy, config, store, logger } = this.deps;
    const tool = agentTools.find((t) => t.name === call.name);
    const base = { ...turn.owner, agent: turn.agent.id, tool: call.name };

    if (!tool) {
      // The model asked for a tool this agent may not use (or that does not exist).
      audit.record({ type: 'SECURITY_DENIAL', ...base, status: 'denied', details: { reason: 'tool_not_permitted' } });
      state.tools.push({ id: call.id, agent: turn.agent.id, tool: call.name, system: 'n/a', risk: 'READ', durationMs: 0, status: 'denied', correlationId: turn.correlationId, mock: false });
      return { content: JSON.stringify({ error: `Tool "${call.name}" is not available to this agent.` }), isError: true };
    }

    const risk = policy.effectiveRisk(tool.name, tool.risk);
    const meta = { id: call.id, agent: turn.agent.id, tool: tool.name, system: tool.targetSystem, risk };
    emit({ type: 'tool.start', tool: meta, label: tool.statusLabel });

    if (policy.requiresConfirmation(risk, config.environment)) {
      const preview = allTools.find((t) => t.name === 'system_previewAction' && t.serverId === tool.serverId);
      const out = preview ? await session.callTool(preview, { tool: tool.name, arguments: call.arguments }, signal) : undefined;
      if (!out?.ok) {
        const message = out?.errorMessage ?? 'This action cannot be prepared right now.';
        const m: ToolExecutionMetadata = { ...meta, durationMs: out?.durationMs ?? 0, status: 'error', correlationId: turn.correlationId, mock: false };
        state.tools.push(m);
        emit({ type: 'tool.error', tool: m, message });
        return { content: JSON.stringify({ error: message }), isError: true };
      }
      const data = (out.structured?.data ?? {}) as {
        preview: PendingActionRecord['preview'];
        normalizedArguments: Record<string, unknown>;
        targetSystem: string;
        mock: boolean;
      };
      const now = Date.now();
      const action: PendingActionRecord = {
        id: newId('a'),
        ...turn.owner,
        conversationId: turn.conversation.id,
        messageId: turn.assistantMessageId,
        agent: turn.agent.id,
        tool: tool.name,
        arguments: data.normalizedArguments,
        argumentsHash: hashArguments(data.normalizedArguments),
        environment: config.environment,
        targetSystem: data.targetSystem,
        risk,
        preview: data.preview,
        status: 'pending',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + config.confirmations.ttlSeconds * 1_000).toISOString(),
      };
      await store.actions.create(action);
      const confirmation = toConfirmation(action);
      state.confirmations.push(confirmation);
      audit.record({
        type: 'SAP_WRITE_REQUESTED',
        ...base,
        targetSystem: action.targetSystem,
        operation: 'SAP_WRITE',
        status: 'pending',
        details: { actionId: action.id, objectType: action.preview.businessObject.type, objectId: action.preview.businessObject.id, risk },
      });
      const m: ToolExecutionMetadata = { ...meta, durationMs: out.durationMs, status: 'pending_confirmation', correlationId: turn.correlationId, mock: data.mock };
      state.tools.push(m);
      emit({ type: 'tool.complete', tool: m });
      emit({ type: 'confirmation.required', confirmation });
      return {
        content: JSON.stringify({
          status: 'AWAITING_USER_CONFIRMATION',
          note: 'The action has NOT been executed. The user sees a confirmation card and must confirm or cancel it. Briefly tell the user what will happen and that it needs their confirmation.',
          action: data.preview.action,
          impact: data.preview.impact,
        }),
      };
    }

    const out = await session.callTool(tool, call.arguments, signal);
    const structured = (out.structured ?? {}) as {
      data?: Record<string, unknown>;
      components?: unknown[];
      source?: { system: string; objectType: string; objectId: string; retrievedAt: string; mock: boolean };
      followUps?: { label: string; prompt: string }[];
    };
    const mock = structured.source?.mock ?? false;
    const m: ToolExecutionMetadata = { ...meta, durationMs: out.durationMs, status: out.ok ? 'success' : 'error', correlationId: turn.correlationId, mock };
    state.tools.push(m);
    M.toolCalls().inc({ tool: tool.name, outcome: out.ok ? 'success' : (out.errorCode ?? 'error'), side: 'client' });

    audit.record({ type: 'MCP_TOOL_INVOKED', ...base, targetSystem: tool.targetSystem, operation: tool.operation, status: out.ok ? 'success' : 'failure', durationMs: out.durationMs });
    if (tool.operation === 'SAP_READ') {
      audit.record({
        type: 'SAP_READ',
        ...base,
        targetSystem: tool.targetSystem,
        operation: 'SAP_READ',
        status: out.ok ? 'success' : out.errorCode === 'SAP_NOT_AUTHORIZED' ? 'denied' : 'failure',
        durationMs: out.durationMs,
        ...(structured.source && { details: { objectType: structured.source.objectType, objectId: structured.source.objectId } }),
      });
    }

    if (!out.ok) {
      emit({ type: 'tool.error', tool: m, message: out.errorMessage ?? 'The tool failed.' });
      return { content: JSON.stringify({ error: out.errorMessage, code: out.errorCode }), isError: true };
    }

    for (const candidate of structured.components ?? []) {
      const component = parseUIComponent(candidate);
      if (!component) {
        logger.warn('chat.component_rejected', { tool: tool.name });
        continue;
      }
      state.components.push(component);
      emit({ type: 'component', component });
    }
    if (structured.source) {
      const source: SourceReference = { id: `${call.id}-src`, ...structured.source, agent: turn.agent.name, tool: tool.name };
      state.sources.push(source);
      emit({ type: 'source', source });
    }
    for (const f of structured.followUps ?? []) {
      if (state.followUps.length >= MAX_FOLLOW_UPS || state.followUps.some((x) => x.prompt === f.prompt)) continue;
      if (typeof f.label !== 'string' || typeof f.prompt !== 'string') continue;
      state.followUps.push({ id: `${call.id}-${state.followUps.length}`, label: f.label.slice(0, 40), prompt: f.prompt.slice(0, 300) });
    }

    const payload = JSON.stringify({ ...(structured.data ?? {}), mock });
    const markers = detectInjectionMarkers(payload);
    if (markers.length) logger.warn('security.injection_markers_in_tool_output', { tool: tool.name, markers });
    const summary = structured.data?.summary;
    if (typeof summary === 'string') state.toolContext.push(`${tool.name}: ${summary.slice(0, 500)}`);
    emit({ type: 'tool.complete', tool: m });
    return { content: fenceUntrusted('tool_result', payload) };
  }

  private execution(turn: PreparedTurn, state: TurnState, started: number): ExecutionMetadata {
    return {
      correlationId: turn.correlationId,
      agent: turn.agent.name,
      modelTier: turn.tier,
      ...(state.selection && { provider: state.selection.provider, model: state.selection.model }),
      durationMs: Date.now() - started,
      usage: state.usage,
      tools: state.tools,
    };
  }

  private publicExecution(turn: PreparedTurn, execution: ExecutionMetadata): ExecutionMetadata {
    const technical = turn.auth.user.roles.includes('AI_POWER_USER') || turn.auth.user.roles.includes('AI_ADMIN');
    if (technical) return execution;
    const { provider: _p, model: _m, ...rest } = execution;
    return rest;
  }

  private async recordUsage(turn: PreparedTurn, state: TurnState, started: number) {
    if (!state.selection) return;
    try {
      await this.deps.store.usage.record({
        ...turn.owner,
        agent: turn.agent.id,
        provider: state.selection.provider,
        model: state.selection.model,
        modelTier: turn.tier,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        durationMs: Date.now() - started,
        day: today(),
        at: new Date().toISOString(),
      });
      this.deps.audit.record({
        type: 'MODEL_PROVIDER_USED',
        ...turn.owner,
        agent: turn.agent.id,
        status: 'success',
        details: { provider: state.selection.provider, model: state.selection.model, tier: turn.tier, inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens },
      });
    } catch (err) {
      this.deps.logger.error('usage.record_failed', { error: err as Error });
    }
  }
}
