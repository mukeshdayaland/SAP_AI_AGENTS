import {
  parseUIComponent,
  type ConfirmationRequest,
  type SourceReference,
  type ToolExecutionMetadata,
  type UIComponent,
  type UserProfile,
  type WorkflowDescriptor,
  type WorkflowRunDTO,
} from '@prowess/contracts';
import type { ToolSpec } from '@prowess/llm';
import type { Logger } from '@prowess/observability';
import type { AgentRegistry } from '../agents/registry.js';
import type { AuditTrail } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import type { AgentDefinition, WorkflowCatalog, WorkflowDefinition, WorkflowStepDefinition } from '../config/catalog.js';
import type { OrchestratorConfig } from '../config/env.js';
import { newId, toConfirmation } from '../conversations/mappers.js';
import { preparePendingAction } from '../conversations/pending-action.js';
import { AppError } from '../errors/app-error.js';
import type { McpGateway, McpSession, McpToolInfo } from '../mcp/gateway.js';
import type { MessageRecord, Owner, PendingActionRecord, Store, WorkflowRunRecord, WorkflowStepRecord } from '../persistence/types.js';
import type { ToolPolicy } from '../security/tool-policy.js';

/** Orchestrator-native tool that lets an agent start a workflow run from a chat turn. */
export const WORKFLOW_TOOL = 'workflow_start';

/** Receives what a run produces while it advances, so a chat turn can stream it and a resume can collect it. */
export interface RunSink {
  component(component: UIComponent): void;
  source(source: SourceReference): void;
  confirmation(confirmation: ConfirmationRequest): void;
  toolStart(tool: Pick<ToolExecutionMetadata, 'id' | 'agent' | 'tool' | 'system' | 'risk'>, label: string): void;
  toolEnd(tool: ToolExecutionMetadata, error?: string): void;
}

export interface RunContext {
  auth: AuthContext;
  conversationId: string;
  /** The assistant message that will show this segment's cards and confirmation. */
  messageId: string;
  correlationId: string;
  signal?: AbortSignal;
}

/** How a confirmed, failed or abandoned write step ended. */
export interface ActionOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'expired';
  structured?: Record<string, unknown>;
  errorMessage?: string;
}

interface CollectedSegment {
  components: UIComponent[];
  sources: SourceReference[];
  confirmations: ConfirmationRequest[];
}

const REFERENCE = /\$\{(input|steps)\.([A-Za-z0-9]+)(?:\.([A-Za-z0-9]+))?\}/g;
const plain = (markdown: string) => markdown.replaceAll('**', '').trim();

function collector(): CollectedSegment & { sink: RunSink } {
  const segment: CollectedSegment = { components: [], sources: [], confirmations: [] };
  return {
    ...segment,
    sink: {
      component: (c) => void segment.components.push(c),
      source: (s) => void segment.sources.push(s),
      confirmation: (c) => void segment.confirmations.push(c),
      toolStart: () => undefined,
      toolEnd: () => undefined,
    },
  };
}

/**
 * Runs configured multi-step SAP processes. A run is a persisted plan: read
 * steps execute as soon as they are reached, a write step becomes a pending
 * action that a person must confirm, and the run resumes from there. Each
 * step executes as its own module agent, so that agent's tool allow-list and
 * roles apply, and SAP authorizes every call as the user.
 */
export class WorkflowService {
  constructor(
    private readonly deps: {
      store: Store;
      mcp: McpGateway;
      agents: AgentRegistry;
      policy: ToolPolicy;
      audit: AuditTrail;
      logger: Logger;
      config: OrchestratorConfig;
      catalog: WorkflowCatalog;
    },
  ) {}

  private definition(id: string): WorkflowDefinition {
    const def = this.deps.catalog.workflows.find((w) => w.id === id);
    if (!def) throw AppError.validation('Unknown workflow.');
    return def;
  }

  /** Workflows the user may run: they must be entitled to every agent that owns a step. */
  forUser(user: UserProfile): WorkflowDefinition[] {
    const entitled = new Set(this.deps.agents.forUser(user).map((a) => a.id));
    return this.deps.catalog.workflows.filter((w) => w.steps.every((s) => entitled.has(s.agent)));
  }

  describe(user: UserProfile): WorkflowDescriptor[] {
    return this.forUser(user).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      input: w.input.map((i) => ({ name: i.name, label: i.label })),
      steps: w.steps.map((s) => ({ id: s.id, title: s.title, agent: this.agentName(s.agent) })),
    }));
  }

  /** The `workflow_start` tool offered to an agent's model, or undefined when the agent may start none. */
  toolSpec(agent: AgentDefinition, user: UserProfile): ToolSpec | undefined {
    const available = this.forUser(user).filter((w) => w.agents.includes(agent.id));
    if (!available.length) return undefined;
    return {
      name: WORKFLOW_TOOL,
      description:
        'Start a multi-step SAP process run when the user asks to carry a process through (not just to look something up). ' +
        'Read steps run immediately; every posting waits for the user to confirm it. Available workflows: ' +
        available.map((w) => `"${w.id}" — ${w.description} Input: ${w.input.map((i) => `${i.name} (${i.label})`).join(', ')}.`).join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string', enum: available.map((w) => w.id) },
          input: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['workflow', 'input'],
      },
    };
  }

  private agentName(id: string): string {
    return this.deps.agents.all().find((a) => a.id === id)?.name ?? id;
  }

  private owner(auth: AuthContext): Owner {
    return { userId: auth.user.id, tenantId: auth.user.tenantId };
  }

  /** Replaces `${input.x}` / `${steps.id.x}`; undefined when a referenced value does not exist. */
  private resolve(template: string, run: WorkflowRunRecord): string | undefined {
    let missing = false;
    const value = template.replace(REFERENCE, (_all, scope: string, first: string, second?: string) => {
      const found = scope === 'input' ? run.input[first] : run.steps.find((s) => s.id === first)?.outputs?.[second ?? ''];
      if (found === undefined) missing = true;
      return found ?? '';
    });
    return missing ? undefined : value;
  }

  private holds(condition: { value: string; equals: string }, run: WorkflowRunRecord): boolean {
    return this.resolve(condition.value, run) === condition.equals;
  }

  snapshot(run: WorkflowRunRecord): UIComponent {
    const def = this.definition(run.workflow);
    return {
      type: 'workflow_run',
      data: {
        id: run.id,
        workflow: def.name,
        title: run.title,
        status: run.status,
        ...(run.reason && { reason: run.reason.slice(0, 400) }),
        steps: def.steps.map((d) => {
          const step = run.steps.find((s) => s.id === d.id);
          return { id: d.id, title: d.title, agent: this.agentName(d.agent), state: step?.state ?? 'pending', ...(step?.detail && { detail: step.detail.slice(0, 400) }) };
        }),
      },
    };
  }

  toDTO(run: WorkflowRunRecord): WorkflowRunDTO {
    const { data } = this.snapshot(run) as Extract<UIComponent, { type: 'workflow_run' }>;
    return { ...data, conversationId: run.conversationId, createdAt: run.createdAt, updatedAt: run.updatedAt };
  }

  /** One paragraph on where the run stands, for the chat message and for the model. */
  summarize(run: WorkflowRunRecord): string {
    const def = this.definition(run.workflow);
    const title = `**${run.title}**`;
    const settled = run.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
    const waiting = def.steps.find((d) => run.steps.find((s) => s.id === d.id)?.state === 'awaiting_confirmation');
    switch (run.status) {
      case 'completed':
        return `${title} is complete: all ${run.steps.length} steps are done.`;
      case 'awaiting_confirmation':
        return `${title}: ${settled} of ${run.steps.length} steps are done. Next is **${waiting?.title ?? 'a posting'}**, which waits for your confirmation.`;
      case 'blocked':
        return `${title} stopped after ${settled} of ${run.steps.length} steps. ${run.reason ?? ''}`.trim();
      case 'failed':
        return `${title} failed after ${settled} of ${run.steps.length} steps. ${run.reason ?? ''}`.trim();
      case 'cancelled':
        return `${title} was cancelled after ${settled} of ${run.steps.length} steps. Nothing further was posted.`;
      default:
        return `${title} is running.`;
    }
  }

  async get(auth: AuthContext, id: string): Promise<WorkflowRunDTO> {
    const run = await this.deps.store.runs.get(this.owner(auth), id);
    if (!run) throw AppError.notFound('Workflow run');
    return this.toDTO(run);
  }

  /** Validates the request, creates the run and advances it until it pauses or ends. */
  async start(ctx: RunContext, workflowId: string, rawInput: Record<string, unknown>, sink: RunSink): Promise<WorkflowRunRecord> {
    const { store, audit } = this.deps;
    const def = this.forUser(ctx.auth.user).find((w) => w.id === workflowId);
    if (!def) throw AppError.validation('That workflow is not available to you.');

    const input: Record<string, string> = {};
    for (const field of def.input) {
      const value = typeof rawInput[field.name] === 'string' ? (rawInput[field.name] as string).trim() : '';
      if (!new RegExp(field.pattern).test(value)) throw AppError.validation(`${field.label} is missing or not valid.`);
      input[field.name] = value;
    }

    const now = new Date().toISOString();
    const run: WorkflowRunRecord = {
      id: newId('r'),
      ...this.owner(ctx.auth),
      workflow: def.id,
      title: '',
      conversationId: ctx.conversationId,
      input,
      status: 'running',
      steps: def.steps.map((s) => ({ id: s.id, state: 'pending' })),
      createdAt: now,
      updatedAt: now,
    };
    run.title = `${def.name} for ${this.resolve(def.subject, run) ?? def.subject}`;
    await store.runs.create(run);
    audit.record({ type: 'WORKFLOW_STARTED', ...this.owner(ctx.auth), status: 'success', details: { runId: run.id, workflow: def.id, conversationId: ctx.conversationId } });

    await this.advance(run, def, ctx, sink);
    return run;
  }

  /** Starts a run outside a chat turn, in a conversation of its own. */
  async startStandalone(auth: AuthContext, workflowId: string, rawInput: Record<string, unknown>, correlationId: string): Promise<{ run: WorkflowRunRecord; message: MessageRecord }> {
    const { store, agents, audit } = this.deps;
    const def = this.forUser(auth.user).find((w) => w.id === workflowId);
    if (!def) throw AppError.validation('That workflow is not available to you.');
    const owner = this.owner(auth);
    const agent = agents.resolve(auth.user, def.agents[0]);
    const now = new Date().toISOString();
    const conversationId = newId('c');
    const messageId = newId('m');
    const segment = collector();

    // Validate before anything is persisted, so a bad request leaves no empty conversation behind.
    for (const field of def.input) {
      if (!new RegExp(field.pattern).test(typeof rawInput[field.name] === 'string' ? (rawInput[field.name] as string).trim() : '')) {
        throw AppError.validation(`${field.label} is missing or not valid.`);
      }
    }
    await store.conversations.create({ id: conversationId, ...owner, title: def.name, agent: agent.id, modelTier: agents.resolveTier(auth.user, agent), createdAt: now, updatedAt: now });
    audit.record({ type: 'CONVERSATION_CREATED', ...owner, agent: agent.id, status: 'success', details: { conversationId } });

    const run = await this.start({ auth, conversationId, messageId, correlationId }, workflowId, rawInput, segment.sink);
    await store.conversations.update(owner, conversationId, { title: run.title });
    const message = await this.persistSegment(run, messageId, agent.id, segment);
    return { run, message };
  }

  /**
   * Continues a run after one of its write steps was confirmed, failed,
   * cancelled or expired. Returns the follow-up message for the conversation,
   * or null when the action does not belong to a run.
   */
  async onActionResolved(auth: AuthContext, action: PendingActionRecord, outcome: ActionOutcome): Promise<MessageRecord | null> {
    if (!action.runId || !action.stepId) return null;
    const owner = this.owner(auth);
    const run = await this.deps.store.runs.get(owner, action.runId);
    const step = run?.steps.find((s) => s.id === action.stepId);
    if (!run || !step || step.state !== 'awaiting_confirmation' || step.actionId !== action.id) return null;

    const def = this.definition(run.workflow);
    const messageId = newId('m');
    const segment = collector();

    if (outcome.status === 'completed') {
      this.absorb(step, outcome.structured);
      step.state = 'done';
      run.status = 'running';
      await this.advance(run, def, { auth, conversationId: run.conversationId, messageId, correlationId: action.id }, segment.sink);
    } else {
      step.state = outcome.status === 'failed' ? 'failed' : 'cancelled';
      run.status = outcome.status === 'failed' ? 'failed' : 'cancelled';
      run.reason = outcome.status === 'failed' ? (outcome.errorMessage ?? 'SAP did not complete the posting.') : outcome.status === 'expired' ? 'The confirmation expired.' : 'The posting was cancelled.';
      step.detail = run.reason;
      await this.finish(run, segment.sink);
    }
    return this.persistSegment(run, messageId, action.agent, segment);
  }

  private async persistSegment(run: WorkflowRunRecord, messageId: string, agent: string, segment: CollectedSegment): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: messageId,
      conversationId: run.conversationId,
      role: 'assistant',
      content: this.summarize(run),
      agent,
      createdAt: new Date().toISOString(),
      status: 'complete',
      response: {
        ...(segment.components.length && { components: segment.components }),
        ...(segment.sources.length && { sources: segment.sources }),
        ...(segment.confirmations.length && { confirmations: segment.confirmations }),
      },
    };
    await this.deps.store.messages.add(record);
    await this.deps.store.conversations.update({ userId: run.userId, tenantId: run.tenantId }, run.conversationId, { updatedAt: record.createdAt });
    return record;
  }

  /** Copies what a tool returned onto the step: its outputs for later steps and a one-line outcome. */
  private absorb(step: WorkflowStepRecord, structured: Record<string, unknown> | undefined): void {
    const outputs = structured?.outputs;
    if (outputs && typeof outputs === 'object') {
      step.outputs = Object.fromEntries(
        Object.entries(outputs as Record<string, unknown>)
          .filter((e): e is [string, string] => typeof e[1] === 'string')
          .slice(0, 20)
          .map(([k, v]) => [k, v.slice(0, 200)]),
      );
    }
    const summary = (structured?.data as { summary?: unknown } | undefined)?.summary;
    if (typeof summary === 'string') step.detail = plain(summary).slice(0, 400);
  }

  private async finish(run: WorkflowRunRecord, sink: RunSink): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await this.deps.store.runs.update({ userId: run.userId, tenantId: run.tenantId }, run);
    sink.component(this.snapshot(run));
    if (run.status !== 'running' && run.status !== 'awaiting_confirmation') {
      this.deps.audit.record({
        type: 'WORKFLOW_ENDED',
        userId: run.userId,
        tenantId: run.tenantId,
        status: run.status === 'completed' ? 'success' : run.status === 'failed' ? 'failure' : 'denied',
        details: { runId: run.id, workflow: run.workflow, outcome: run.status },
      });
    }
  }

  /** Executes pending steps in order until one needs confirmation, fails, blocks the run, or none are left. */
  private async advance(run: WorkflowRunRecord, def: WorkflowDefinition, ctx: RunContext, sink: RunSink): Promise<void> {
    const { mcp, agents, policy, audit, config, logger } = this.deps;
    const owner = this.owner(ctx.auth);
    const sessions = new Map<string, McpSession>();
    const fail = (step: WorkflowStepRecord, reason: string) => {
      step.state = 'failed';
      step.detail = reason;
      run.status = 'failed';
      run.reason = reason;
    };

    try {
      let tools: McpToolInfo[] = [];
      try {
        tools = await mcp.listTools(config.environment);
      } catch (err) {
        logger.warn('workflow.tools_unavailable', { error: (err as Error).message });
      }

      for (const step of run.steps) {
        if (step.state !== 'pending') continue;
        if (ctx.signal?.aborted) break;
        const d = def.steps.find((s) => s.id === step.id) as WorkflowStepDefinition;

        if (d.skipWhen.some((c) => this.holds(c, run))) {
          step.state = 'skipped';
          step.detail = 'Already done in SAP.';
          continue;
        }

        const args: Record<string, string> = {};
        for (const [key, template] of Object.entries(d.arguments)) {
          const value = this.resolve(template, run);
          if (value === undefined) break;
          args[key] = value;
        }
        if (Object.keys(args).length !== Object.keys(d.arguments).length) {
          fail(step, 'An earlier step did not provide a value this step needs.');
          break;
        }

        // The step runs as its module agent: that agent's roles and tool allow-list apply.
        const agent = agents.resolve(ctx.auth.user, d.agent);
        const tool = agents.toolsFor(agent, tools).find((t) => t.name === d.tool);
        if (!tool) {
          audit.record({ type: 'SECURITY_DENIAL', ...owner, agent: agent.id, tool: d.tool, status: 'denied', details: { reason: 'tool_not_permitted', runId: run.id } });
          fail(step, tools.length ? `The ${agent.name} may not use the tool for this step.` : 'SAP tools are temporarily unavailable.');
          break;
        }

        let session = sessions.get(agent.id);
        if (!session) {
          session = mcp.session({ user: ctx.auth.user, agent: agent.id, environment: config.environment, correlationId: ctx.correlationId, ...(ctx.auth.token && { userToken: ctx.auth.token }) });
          sessions.set(agent.id, session);
        }
        const risk = policy.effectiveRisk(tool.name, tool.risk);
        const meta = { id: `${run.id}-${step.id}`, agent: agent.id, tool: tool.name, system: tool.targetSystem, risk };
        sink.toolStart(meta, tool.statusLabel);

        if (policy.requiresConfirmation(risk, config.environment)) {
          const prepared = await preparePendingAction(this.deps, {
            owner,
            conversationId: ctx.conversationId,
            messageId: ctx.messageId,
            agent: agent.id,
            tool,
            risk,
            arguments: args,
            allTools: tools,
            session,
            ...(ctx.signal && { signal: ctx.signal }),
            run: { runId: run.id, stepId: step.id },
          });
          if (!prepared.ok) {
            sink.toolEnd({ ...meta, durationMs: prepared.durationMs, status: 'error', correlationId: ctx.correlationId, mock: false }, prepared.message);
            fail(step, prepared.message);
            break;
          }
          step.state = 'awaiting_confirmation';
          step.actionId = prepared.action.id;
          run.status = 'awaiting_confirmation';
          sink.toolEnd({ ...meta, durationMs: prepared.durationMs, status: 'pending_confirmation', correlationId: ctx.correlationId, mock: prepared.mock });
          sink.confirmation(toConfirmation(prepared.action));
          break;
        }

        const out = await session.callTool(tool, args, ctx.signal);
        const structured = (out.structured ?? {}) as { components?: unknown[]; source?: Omit<SourceReference, 'id' | 'agent' | 'tool'> };
        audit.record({ type: 'MCP_TOOL_INVOKED', ...owner, agent: agent.id, tool: tool.name, targetSystem: tool.targetSystem, operation: tool.operation, status: out.ok ? 'success' : 'failure', durationMs: out.durationMs });
        if (tool.operation === 'SAP_READ') {
          audit.record({
            type: 'SAP_READ',
            ...owner,
            agent: agent.id,
            tool: tool.name,
            targetSystem: tool.targetSystem,
            operation: 'SAP_READ',
            status: out.ok ? 'success' : out.errorCode === 'SAP_NOT_AUTHORIZED' ? 'denied' : 'failure',
            durationMs: out.durationMs,
            ...(structured.source && { details: { objectType: structured.source.objectType, objectId: structured.source.objectId, runId: run.id } }),
          });
        }
        const done: ToolExecutionMetadata = { ...meta, durationMs: out.durationMs, status: out.ok ? 'success' : 'error', correlationId: ctx.correlationId, mock: structured.source?.mock ?? false };
        if (!out.ok) {
          const reason = out.errorMessage ?? 'The SAP tool failed.';
          sink.toolEnd(done, reason);
          fail(step, reason);
          break;
        }

        for (const candidate of structured.components ?? []) {
          const component = parseUIComponent(candidate);
          if (component) sink.component(component);
          else logger.warn('workflow.component_rejected', { tool: tool.name });
        }
        if (structured.source) sink.source({ id: `${meta.id}-src`, ...structured.source, agent: agent.name, tool: tool.name });
        this.absorb(step, out.structured);
        step.state = 'done';
        sink.toolEnd(done);

        const halt = d.haltWhen.find((c) => this.holds(c, run));
        if (halt) {
          run.status = 'blocked';
          run.reason = halt.reason;
          break;
        }
      }

      if (run.status === 'running' && run.steps.every((s) => s.state === 'done' || s.state === 'skipped')) run.status = 'completed';
      if (run.status === 'running') {
        // Stopped mid-way (the user aborted the turn): a run must never be left looking active.
        run.status = 'cancelled';
        run.reason = 'The run was stopped before it finished.';
      }
    } catch (err) {
      // A thrown error (for example a lost entitlement) must not leave the run looking active.
      const reason = err instanceof AppError ? err.message : 'The run could not continue.';
      if (!(err instanceof AppError)) logger.error('workflow.advance_failed', { runId: run.id, error: err as Error });
      const current = run.steps.find((s) => s.state === 'pending');
      if (current) fail(current, reason);
      else Object.assign(run, { status: 'failed', reason });
    } finally {
      await Promise.all([...sessions.values()].map((s) => s.close()));
      await this.finish(run, sink);
    }
  }
}
