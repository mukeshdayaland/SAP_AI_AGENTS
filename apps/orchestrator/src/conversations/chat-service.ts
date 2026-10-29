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
  type UiLocale,
} from '@prowess/contracts';
import type { LLMMessage, ModelRouter, RoutedSelection, ToolCall, ToolSpec } from '@prowess/llm';
import { currentContext, enrichContext, M, type Logger } from '@prowess/observability';
import { detectInjectionMarkers, fenceUntrusted } from '@prowess/security';
import type { AgentRegistry } from '../agents/registry.js';
import type { AuditTrail } from '../audit/audit.js';
import { tokensOf, type AuthContext } from '../auth/types.js';
import { BROWSER_TOOLS, FIORI_OPEN_TOOL, isBrowserTool, toBrowserAction, type BrowserBridge } from '../browser/browser-bridge.js';
import type { AgentDefinition } from '../config/catalog.js';
import type { OrchestratorConfig } from '../config/env.js';
import { AppError, toAppError, toPublicError } from '../errors/app-error.js';
import { buildContext, fitToolResults, HANDOFF_TOOL, systemPrompt, toolSpecForModel, toolSpecTokens, updateSummary, withAttachments } from '../llm/context.js';
import type { McpGateway, McpSession, McpToolInfo } from '../mcp/gateway.js';
import type { ConversationRecord, MessageRecord, Owner, Store } from '../persistence/types.js';
import type { ToolPolicy } from '../security/tool-policy.js';
import { today, type QuotaService } from '../usage/limits.js';
import { WORKFLOW_TOOL, type WorkflowService } from '../workflows/workflow-service.js';
import { newId, titleFrom, toConfirmation } from './mappers.js';
import { failureForModel, failureNotice, noticeKind } from './notice.js';
import { preparePendingAction } from './pending-action.js';

export interface ChatDeps {
  store: Store;
  router: ModelRouter;
  mcp: McpGateway;
  agents: AgentRegistry;
  policy: ToolPolicy;
  audit: AuditTrail;
  quota: QuotaService;
  workflows: WorkflowService;
  browser: BrowserBridge;
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
  /** The interface language; the model answers in it. */
  locale: UiLocale;
}

export type Emit = (event: StreamEvent) => void;

/** Identity of a card showing one SAP business object, so the same object is shown once per answer. */
function componentKey(c: UIComponent): string | undefined {
  const data = c.data as { number?: unknown; materialDocument?: unknown };
  const id = data.number ?? data.materialDocument;
  return typeof id === 'string' && c.type !== 'workflow_run' ? `${c.type}:${id}` : undefined;
}

/** Tool spec of the hand-off: one of the other agents the user may use, and the request to pass on. */
function handoffSpec(others: Pick<AgentDefinition, 'id' | 'name' | 'description'>[]): ToolSpec {
  return {
    name: HANDOFF_TOOL,
    // The agents and their areas are listed in the system prompt; the enum names the ids.
    description: "Hand the request over to another agent of this workspace when it belongs to that agent's area and you have no tool for it. The platform continues the request with that agent.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: others.map((o) => o.id) },
        reason: { type: 'string', description: 'Why the request belongs to that agent, in a few words.' },
      },
      required: ['agent'],
    },
  };
}

/** An earlier answer opened a Fiori app or worked in one, so the page may still be open beside the conversation. */
const usedFiori = (m: MessageRecord) => m.response?.execution?.tools.some((t) => t.status === 'success' && (t.tool === FIORI_OPEN_TOOL || isBrowserTool(t.tool))) ?? false;

const BROWSER_LABELS ={ read: 'Reading the Fiori page', point: 'Pointing in Fiori', type: 'Typing in Fiori', click: 'Clicking in Fiori' } as const;

const MAX_FOLLOW_UPS = 4;
/** A request is handed over at most once per answer, so agents cannot pass it back and forth. */
const MAX_HANDOFFS = 1;

interface TurnState {
  text: string;
  components: UIComponent[];
  sources: SourceReference[];
  followUps: AgentAction[];
  confirmations: ConfirmationRequest[];
  tools: ToolExecutionMetadata[];
  toolContext: string[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  selection?: RoutedSelection;
}

export class ChatService {
  constructor(private readonly deps: ChatDeps) {}

  /**
   * Validates and persists the user's turn. Throws AppError for anything the
   * client must fix (authorization, quota, unknown IDs) *before* streaming
   * starts, so those surface as proper HTTP errors.
   */
  async prepare(auth: AuthContext, req: ChatRequest, locale: UiLocale = 'en'): Promise<PreparedTurn> {
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
      locale,
    };
  }

  /** Runs the agent loop and streams events. Never throws; failures become `error` events. */
  async execute(turn: PreparedTurn, emit: Emit, signal: AbortSignal): Promise<void> {
    const { store, router, mcp, agents, workflows, config, logger } = this.deps;
    const started = Date.now();
    const state: TurnState = { text: '', components: [], sources: [], followUps: [], confirmations: [], tools: [], toolContext: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
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
      if (!allTools.length && turn.agent.allowedTools.length) {
        emit({ type: 'status', step: { id: 'tools', label: 'SAP tools are temporarily unavailable', state: 'skipped' } });
      }

      // The orchestrator routes the request: when the agent finds that it belongs to another agent's area,
      // the turn continues with that agent, but only with one the user is entitled to and only once.
      let handoffs = 0;
      let overflow: MessageRecord[] = [];
      turns: for (;;) {
        const agentTools = agents.toolsFor(turn.agent, allTools, turn.auth.user);
        // Tool definitions are re-sent with every model call and are most of each request, so offer only what the agent can use now.
        const toolSpecs: ToolSpec[] = agentTools.map(toolSpecForModel);
        // Workflow runs execute SAP tools, so the entry point is only offered while those are reachable.
        const workflowSpec = allTools.length ? workflows.toolSpec(turn.agent, turn.auth.user) : undefined;
        if (workflowSpec) toolSpecs.push(workflowSpec);
        // An agent that can open a Fiori app can also read and act in the page the user then has open,
        // once a page is open: opened earlier in the conversation, or in this turn (added below).
        const canUseFiori = agentTools.some((t) => t.name === FIORI_OPEN_TOOL);
        if (canUseFiori && turn.history.some(usedFiori)) toolSpecs.push(...BROWSER_TOOLS);
        const others = handoffs < MAX_HANDOFFS ? agents.forUser(turn.auth.user).filter((a) => a.id !== turn.agent.id) : [];
        if (others.length) toolSpecs.push(handoffSpec(others));

        const tier = router.tier(turn.tier)!;
        const budget = (tools: readonly ToolSpec[] | undefined) => ({
          maxContextTokens: tier.maxContextTokens,
          reservedOutputTokens: tier.maxOutputTokens,
          toolTokens: tools ? toolSpecTokens(tools) : 0,
          ...(tier.maxHistoryTokens && { maxHistoryTokens: tier.maxHistoryTokens }),
        });
        const context = buildContext({
          system: systemPrompt(turn.agent, config.environment, turn.auth.user.displayName, new Date(), others, turn.locale),
          conversation: turn.conversation,
          history: turn.history,
          userTurn: turn.userTurn,
          budget: budget(toolSpecs),
        });
        overflow = context.overflow;
        const messages: LLMMessage[] = context.messages;

        // The SAP session carries the agent in its signed principal, so a hand-off opens a new one.
        await session?.close();
        session = mcp.session({
          user: turn.auth.user,
          agent: turn.agent.id,
          environment: config.environment,
          correlationId: turn.correlationId,
          ...tokensOf(turn.auth),
        });

        for (let round = 0; round <= config.llm.maxToolRounds; round++) {
          // Per model call: a step in the Fiori pane may wait for the user, which must not use up the model's time.
          const llmSignal = AbortSignal.any([signal, AbortSignal.timeout(config.llm.requestTimeoutMs)]);
          const offerTools = round < config.llm.maxToolRounds && toolSpecs.length ? toolSpecs : undefined;
          const shortened = fitToolResults(messages, budget(offerTools));
          if (shortened) logger.info('chat.tool_results_shortened', { count: shortened, round });
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
              state.usage.cachedInputTokens += chunk.usage.cachedInputTokens ?? 0;
            }
          }
          if (round === 0 && !handoffs) emit({ type: 'status', step: { id: 'understand', label: 'Understanding request', state: 'done' } });
          if (signal.aborted) {
            status = 'stopped';
            break turns;
          }
          if (!calls.length) break turns;

          const handoff = calls.find((c) => c.name === HANDOFF_TOOL);
          const target = handoff && others.find((a) => a.id === (handoff.arguments as { agent?: unknown }).agent);
          if (target) {
            await this.handOver(turn, target, handoffs, emit);
            handoffs += 1;
            continue turns;
          }

          messages.push({ role: 'assistant', content: roundText, toolCalls: calls });
          for (const call of calls) {
            if (signal.aborted) break;
            const result = await this.runToolCall(turn, call, agentTools, allTools, session, state, emit, signal);
            await store.archive.append({
              ...turn.owner,
              kind: 'tool_call',
              conversationId: turn.conversation.id,
              messageId: turn.assistantMessageId,
              correlationId: turn.correlationId,
              agent: turn.agent.id,
              at: new Date().toISOString(),
              data: { toolCallId: call.id, tool: call.name, arguments: call.arguments, result: result.content, ...(result.isError && { isError: true }) },
            });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content, ...(result.isError && { isError: true }) });
          }
          if (canUseFiori && !toolSpecs.some((t) => isBrowserTool(t.name)) && state.tools.some((t) => t.tool === FIORI_OPEN_TOOL && t.status === 'success')) {
            toolSpecs.push(...BROWSER_TOOLS);
          }
          emit({ type: 'status', step: { id: `compose-${handoffs}-${round}`, label: 'Preparing response', state: 'running' } });
        }
        break;
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

      void updateSummary({ store, router, tier: turn.tier, conversation: turn.conversation, overflow, logger });
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

  /** Continues the turn with another agent: the user sees the hand-over and the new agent answers in the same message. */
  private async handOver(turn: PreparedTurn, target: AgentDefinition, index: number, emit: Emit): Promise<void> {
    const from = turn.agent;
    let tier: string;
    try {
      tier = this.deps.agents.resolveTier(turn.auth.user, target, turn.tier);
    } catch {
      tier = this.deps.agents.resolveTier(turn.auth.user, target);
    }
    await this.deps.quota.assertWithinQuota(turn.auth.user.id, target.id);
    turn.agent = target;
    turn.tier = tier;
    enrichContext({ agent: target.id });
    this.deps.audit.record({ type: 'AGENT_INVOKED', ...turn.owner, agent: target.id, status: 'success', details: { conversationId: turn.conversation.id, modelTier: tier, handedOverFrom: from.id } });
    emit({ type: 'status', step: { id: `handoff-${index}`, label: `${from.name} handed this over to ${target.name}`, state: 'done' } });
    emit({ type: 'agent.handoff', from: from.id, agent: target.id, modelTier: tier });
  }

  /** Shows a failed SAP call to the user as a notice card. The same failure is shown once per answer. */
  private notify(turn: PreparedTurn, state: TurnState, emit: Emit, code: string | undefined, message: string | undefined): void {
    const component = failureNotice({ code, message, correlationId: turn.correlationId, retryPrompt: turn.userTurn });
    // A workflow run card that already states the same reason is not repeated as a notice.
    const shown = state.components.some(
      (c) => (c.type === 'notice' && c.data.kind === component.data.kind && c.data.message === component.data.message) || (c.type === 'workflow_run' && c.data.reason === component.data.message),
    );
    if (shown) return;
    state.components.push(component);
    emit({ type: 'component', component });
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
    const { audit, policy, config, logger } = this.deps;
    if (call.name === WORKFLOW_TOOL && this.deps.workflows.toolSpec(turn.agent, turn.auth.user)) return this.startWorkflow(turn, call, state, emit, signal);
    // A hand-off the orchestrator did not act on: the agent named is not available to this user.
    if (call.name === HANDOFF_TOOL) return { content: JSON.stringify({ error: 'That agent is not available to this user. Answer within your own area.' }), isError: true };
    if (isBrowserTool(call.name) && agentTools.some((t) => t.name === FIORI_OPEN_TOOL)) return this.runBrowserAction(turn, call, state, emit, signal);
    const tool = agentTools.find((t) => t.name === call.name);
    const base = { ...turn.owner, agent: turn.agent.id, tool: call.name };

    if (!tool) {
      // The model asked for a tool this agent may not use (or that does not exist).
      audit.record({ type: 'SECURITY_DENIAL', ...base, status: 'denied', details: { reason: 'tool_not_permitted' } });
      state.tools.push({ id: call.id, agent: turn.agent.id, tool: call.name, system: 'n/a', risk: 'READ', durationMs: 0, status: 'denied', correlationId: turn.correlationId, mock: false });
      return { content: JSON.stringify({ error: `Tool "${call.name}" is not available to this agent.` }), isError: true };
    }

    const risk = policy.effectiveRisk(tool.name, tool.risk);
    const meta = { id: call.id, agent: turn.agent.id, tool: tool.name, system: tool.targetSystem, risk, label: tool.statusLabel };
    emit({ type: 'tool.start', tool: meta, label: tool.statusLabel });

    if (policy.requiresConfirmation(risk, config.environment)) {
      const prepared = await preparePendingAction(this.deps, {
        owner: turn.owner,
        conversationId: turn.conversation.id,
        messageId: turn.assistantMessageId,
        agent: turn.agent.id,
        tool,
        risk,
        arguments: call.arguments,
        allTools,
        session,
        signal,
      });
      if (!prepared.ok) {
        const m: ToolExecutionMetadata = { ...meta, durationMs: prepared.durationMs, status: noticeKind(prepared.code) === 'NOT_AUTHORIZED' ? 'denied' : 'error', correlationId: turn.correlationId, mock: false };
        state.tools.push(m);
        emit({ type: 'tool.error', tool: m, message: prepared.message });
        this.notify(turn, state, emit, prepared.code, prepared.message);
        return { content: failureForModel(prepared.message), isError: true };
      }
      const confirmation = toConfirmation(prepared.action);
      state.confirmations.push(confirmation);
      const m: ToolExecutionMetadata = { ...meta, durationMs: prepared.durationMs, status: 'pending_confirmation', correlationId: turn.correlationId, mock: prepared.mock };
      state.tools.push(m);
      emit({ type: 'tool.complete', tool: m });
      emit({ type: 'confirmation.required', confirmation });
      return {
        content: JSON.stringify({
          status: 'AWAITING_USER_CONFIRMATION',
          note: 'The action has NOT been executed. The user sees a confirmation card and must confirm or cancel it. Briefly tell the user what will happen and that it needs their confirmation.',
          action: prepared.action.preview.action,
          impact: prepared.action.preview.impact,
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
    const m: ToolExecutionMetadata = { ...meta, durationMs: out.durationMs, status: out.ok ? 'success' : noticeKind(out.errorCode) === 'NOT_AUTHORIZED' ? 'denied' : 'error', correlationId: turn.correlationId, mock };
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
      this.notify(turn, state, emit, out.errorCode, out.errorMessage);
      return { content: failureForModel(out.errorMessage), isError: true };
    }

    for (const candidate of structured.components ?? []) {
      const component = parseUIComponent(candidate);
      if (!component) {
        logger.warn('chat.component_rejected', { tool: tool.name });
        continue;
      }
      const key = componentKey(component);
      if (key && state.components.some((c) => componentKey(c) === key)) continue;
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

  /**
   * Carries out one step in the Fiori pane of the user's browser and tells the model what the page shows afterwards.
   * The page is the user's own SAP session: what it contains reaches the model as untrusted data, like a tool result.
   */
  private async runBrowserAction(turn: PreparedTurn, call: ToolCall, state: TurnState, emit: Emit, signal: AbortSignal): Promise<{ content: string; isError?: boolean }> {
    const action = toBrowserAction(call.name, call.arguments as Record<string, unknown>);
    if (!action) return { content: JSON.stringify({ error: 'Name the element with the ref that fiori_read returned.' }), isError: true };
    const meta = { id: call.id, agent: turn.agent.id, tool: call.name, system: 'Fiori', risk: 'READ' as const, label: BROWSER_LABELS[action.kind] };
    emit({ type: 'tool.start', tool: meta, label: BROWSER_LABELS[action.kind] });
    const started = Date.now();
    const result = await this.deps.browser.request(turn.owner, action, (a) => emit({ type: 'browser.action', action: a }), signal);
    const durationMs = Date.now() - started;
    const m: ToolExecutionMetadata = { ...meta, durationMs, status: result.ok ? 'success' : 'error', correlationId: turn.correlationId, mock: false };
    state.tools.push(m);
    this.deps.audit.record({ type: 'BROWSER_ACTION', ...turn.owner, agent: turn.agent.id, tool: call.name, status: result.ok ? 'success' : 'failure', durationMs, details: { conversationId: turn.conversation.id } });
    emit(result.ok ? { type: 'tool.complete', tool: m } : { type: 'tool.error', tool: m, message: result.message ?? 'The step was not carried out.' });
    const summary = result.ok ? (action.kind === 'read' ? `Read the Fiori page "${result.page?.title ?? ''}".` : 'Done in the Fiori page.') : (result.message ?? 'The step was not carried out.');
    return { content: fenceUntrusted('tool_result', JSON.stringify({ ok: result.ok, summary, ...(result.page && { page: result.page }) })), ...(!result.ok && { isError: true }) };
  }

  /** Starts a workflow run from the chat turn; its cards and first confirmation stream into this answer. */
  private async startWorkflow(turn: PreparedTurn, call: ToolCall, state: TurnState, emit: Emit, signal: AbortSignal): Promise<{ content: string; isError?: boolean }> {
    const { workflows } = this.deps;
    const args = call.arguments as { workflow?: unknown; input?: unknown };
    const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
    try {
      const run = await workflows.start(
        { auth: turn.auth, conversationId: turn.conversation.id, messageId: turn.assistantMessageId, correlationId: turn.correlationId, signal },
        String(args.workflow ?? ''),
        input,
        {
          component: (component) => {
            state.components.push(component);
            emit({ type: 'component', component });
          },
          source: (source) => {
            state.sources.push(source);
            emit({ type: 'source', source });
          },
          confirmation: (confirmation) => {
            state.confirmations.push(confirmation);
            emit({ type: 'confirmation.required', confirmation });
          },
          toolStart: (tool, label) => emit({ type: 'tool.start', tool, label }),
          toolEnd: (tool, error) => {
            state.tools.push(tool);
            emit(error === undefined ? { type: 'tool.complete', tool } : { type: 'tool.error', tool, message: error });
          },
        },
      );
      const summary = workflows.summarize(run);
      state.toolContext.push(`${WORKFLOW_TOOL}: ${summary.slice(0, 500)}`);
      return {
        content: fenceUntrusted(
          'tool_result',
          JSON.stringify({
            summary,
            status: run.status,
            note: 'The user sees the run, its cards and any confirmation card. Postings happen only after the user confirms; never claim a step was posted unless its state is "done".',
            steps: workflows.toDTO(run).steps.map((s) => ({ step: s.title, agent: s.agent, state: s.state, detail: s.detail })),
          }),
        ),
      };
    } catch (err) {
      const appError = toAppError(err);
      if (appError.category !== 'VALIDATION' && appError.category !== 'AUTHORIZATION') throw err;
      return { content: JSON.stringify({ error: appError.message }), isError: true };
    }
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
        cachedInputTokens: state.usage.cachedInputTokens,
        durationMs: Date.now() - started,
        day: today(),
        at: new Date().toISOString(),
      });
      this.deps.audit.record({
        type: 'MODEL_PROVIDER_USED',
        ...turn.owner,
        agent: turn.agent.id,
        status: 'success',
        details: { provider: state.selection.provider, model: state.selection.model, tier: turn.tier, inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens, cachedInputTokens: state.usage.cachedInputTokens },
      });
    } catch (err) {
      this.deps.logger.error('usage.record_failed', { error: err as Error });
    }
  }
}
