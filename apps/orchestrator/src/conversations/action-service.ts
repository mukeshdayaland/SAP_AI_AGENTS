import { parseUIComponent, type ConfirmationRequest, type MessageDTO, type SourceReference, type UIComponent } from '@prowess/contracts';
import { currentContext, newCorrelationId, type Logger } from '@prowess/observability';
import { MCP_AUDIENCE, signAssertion, type ConfirmationAssertion } from '@prowess/security';
import type { AgentRegistry } from '../agents/registry.js';
import type { AuditTrail } from '../audit/audit.js';
import { tokensOf, type AuthContext } from '../auth/types.js';
import type { OrchestratorConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { McpGateway } from '../mcp/gateway.js';
import type { MessageRecord, Owner, PendingActionRecord, Store } from '../persistence/types.js';
import type { ActionOutcome, WorkflowService } from '../workflows/workflow-service.js';
import { newId, toConfirmation, toMessageDTO } from './mappers.js';
import { failureNotice } from './notice.js';

/**
 * Human-in-the-loop execution of SAP writes. The only code path that can
 * cause an MCP write: it requires a pending action created by the
 * orchestrator, owned by the caller, unexpired, in the same environment, and
 * explicitly confirmed. Writes are never retried automatically.
 */
export class ActionService {
  constructor(
    private readonly deps: {
      store: Store;
      mcp: McpGateway;
      agents: AgentRegistry;
      audit: AuditTrail;
      workflows: WorkflowService;
      logger: Logger;
      config: OrchestratorConfig;
    },
  ) {}

  /** When the action is a step of a workflow run, lets the run continue (or end) and returns its follow-up message. */
  private async continueRun(auth: AuthContext, action: PendingActionRecord, outcome: ActionOutcome): Promise<MessageDTO[]> {
    try {
      const followUp = await this.deps.workflows.onActionResolved(auth, action, outcome);
      return followUp ? [toMessageDTO(followUp, auth.user)] : [];
    } catch (err) {
      // The SAP write itself is already final; a failure here must not mask its result.
      this.deps.logger.error('workflow.resume_failed', { actionId: action.id, error: err as Error });
      return [];
    }
  }

  private async load(auth: AuthContext, id: string): Promise<{ owner: Owner; action: PendingActionRecord }> {
    const owner = { userId: auth.user.id, tenantId: auth.user.tenantId };
    const action = await this.deps.store.actions.get(owner, id);
    if (!action) throw AppError.notFound('Action');
    if (action.status === 'pending' && action.expiresAt < new Date().toISOString()) {
      await this.deps.store.actions.transition(owner, id, 'pending', 'expired');
      await this.syncCard(owner, { ...action, status: 'expired' });
      await this.continueRun(auth, action, { status: 'expired' });
      throw new AppError('ACTION_EXPIRED', 'This confirmation has expired. Ask again to prepare a new one.', 'VALIDATION');
    }
    if (action.status !== 'pending') throw new AppError('ACTION_NOT_PENDING', `This action is already ${action.status}.`, 'VALIDATION');
    return { owner, action };
  }

  /** The user's decision on a write, with what was sent to SAP, for the conversation archive. */
  private archiveDecision(action: PendingActionRecord, decision: 'confirmed' | 'cancelled', outcome?: Record<string, unknown>) {
    const correlationId = currentContext()?.correlationId;
    return this.deps.store.archive.append({
      userId: action.userId,
      tenantId: action.tenantId,
      kind: 'action',
      conversationId: action.conversationId,
      messageId: action.messageId,
      ...(correlationId && { correlationId }),
      agent: action.agent,
      at: new Date().toISOString(),
      data: { actionId: action.id, tool: action.tool, arguments: action.arguments, environment: action.environment, targetSystem: action.targetSystem, preview: action.preview, decision, ...outcome },
    });
  }

  /** Keeps the confirmation card stored on the originating message in sync. */
  private async syncCard(owner: Owner, action: PendingActionRecord) {
    const conversation = await this.deps.store.conversations.get(owner, action.conversationId);
    if (!conversation) return;
    const msg = (await this.deps.store.messages.list(action.conversationId)).find((m) => m.id === action.messageId);
    if (!msg?.response?.confirmations) return;
    const confirmations = msg.response.confirmations.map((c) => (c.id === action.id ? toConfirmation(action) : c));
    await this.deps.store.messages.update(action.conversationId, msg.id, { response: { ...msg.response, confirmations } });
  }

  async cancel(auth: AuthContext, id: string): Promise<{ confirmation: ConfirmationRequest; followUp: MessageDTO[] }> {
    const { owner, action } = await this.load(auth, id);
    if (!(await this.deps.store.actions.transition(owner, id, 'pending', 'cancelled'))) {
      throw new AppError('ACTION_NOT_PENDING', 'This action was already processed.', 'VALIDATION');
    }
    const updated = { ...action, status: 'cancelled' as const };
    await this.syncCard(owner, updated);
    await this.archiveDecision(action, 'cancelled');
    this.deps.audit.record({ type: 'SAP_WRITE_CANCELLED', ...owner, agent: action.agent, tool: action.tool, targetSystem: action.targetSystem, operation: 'SAP_WRITE', status: 'success', details: { actionId: id } });
    return { confirmation: toConfirmation(updated), followUp: await this.continueRun(auth, action, { status: 'cancelled' }) };
  }

  async confirm(auth: AuthContext, id: string, acknowledgeEnvironment?: string): Promise<{ confirmation: ConfirmationRequest; message: MessageDTO; followUp: MessageDTO[] }> {
    const { store, mcp, agents, audit, config } = this.deps;
    const { owner, action } = await this.load(auth, id);
    const details = { actionId: id, objectType: action.preview.businessObject.type, objectId: action.preview.businessObject.id };
    const auditBase = { ...owner, agent: action.agent, tool: action.tool, targetSystem: action.targetSystem, operation: 'SAP_WRITE' };

    if (action.environment !== config.environment) {
      audit.record({ type: 'SECURITY_DENIAL', ...auditBase, status: 'denied', details: { ...details, reason: 'environment_mismatch' } });
      throw AppError.forbidden('This action was prepared for a different environment.');
    }
    if (action.environment === 'PROD' && acknowledgeEnvironment !== 'PROD') {
      throw new AppError('PROD_ACK_REQUIRED', 'Production changes must be explicitly acknowledged.', 'VALIDATION');
    }
    agents.resolve(auth.user, action.agent); // still entitled to the agent

    if (!(await store.actions.transition(owner, id, 'pending', 'confirmed'))) {
      throw new AppError('ACTION_NOT_PENDING', 'This action was already processed.', 'VALIDATION');
    }
    audit.record({ type: 'SAP_WRITE_CONFIRMED', ...auditBase, status: 'success', details });

    const token = signAssertion<ConfirmationAssertion>(
      { typ: 'confirmation', act: action.id, sub: auth.user.id, tool: action.tool, args: action.argumentsHash, env: action.environment, aud: MCP_AUDIENCE },
      config.assertionSecret,
      60,
    );
    const tool = (await mcp.listTools(config.environment)).find((t) => t.name === action.tool);
    const session = mcp.session(
      { user: auth.user, agent: action.agent, environment: config.environment, correlationId: `${id}`, ...tokensOf(auth) },
      token,
    );
    const out = tool
      ? await session.callTool(tool, action.arguments).finally(() => session.close())
      : { ok: false, structured: undefined, errorMessage: 'The SAP tool service is not reachable.', durationMs: 0 };

    // A write the tool service sent but got no answer for may still have been made in SAP.
    const errorCode = out.errorCode === 'TOOL_TIMEOUT' ? 'SAP_OUTCOME_UNKNOWN' : out.errorCode;
    const unknown = errorCode === 'SAP_OUTCOME_UNKNOWN';
    const errorMessage = out.errorCode === 'TOOL_TIMEOUT' ? 'The SAP tool service did not answer in time, so it is not known whether the change was made.' : out.errorMessage;
    const finalStatus = out.ok ? 'completed' : 'failed';
    await store.actions.transition(owner, id, 'confirmed', finalStatus);
    const updated: PendingActionRecord = { ...action, status: finalStatus };
    await this.syncCard(owner, updated);
    await this.archiveDecision(action, 'confirmed', { status: finalStatus, durationMs: out.durationMs, ...(errorCode && { errorCode }), ...(errorMessage && { errorMessage }), ...(out.structured !== undefined && { result: out.structured }) });
    audit.record({ type: out.ok ? 'SAP_WRITE_COMPLETED' : 'SAP_WRITE_FAILED', ...auditBase, status: out.ok ? 'success' : 'failure', durationMs: out.durationMs, details: { ...details, ...(errorCode && { errorCode }) } });

    const structured = (out.structured ?? {}) as { data?: { summary?: string }; components?: unknown[]; source?: Omit<SourceReference, 'id' | 'agent' | 'tool'> };
    const components = (structured.components ?? []).map(parseUIComponent).filter((c): c is UIComponent => c !== null);
    // A failed write is shown as an error notice with what to do next and a reference for support.
    if (!out.ok) components.unshift(failureNotice({ code: errorCode, message: errorMessage, correlationId: currentContext()?.correlationId ?? newCorrelationId() }));
    const agentName = agents.all().find((a) => a.id === action.agent)?.name ?? action.agent;
    const record: MessageRecord = {
      id: newId('m'),
      conversationId: action.conversationId,
      role: 'assistant',
      content: out.ok
        ? (structured.data?.summary ?? `${action.preview.action} completed.`)
        : unknown
          ? `**${action.preview.action}: result unknown.** Check SAP before you try again.`
          : `**${action.preview.action} was not completed.**`,
      agent: action.agent,
      createdAt: new Date().toISOString(),
      status: 'complete',
      response: {
        ...(components.length && { components }),
        ...(structured.source && { sources: [{ id: `${id}-src`, ...structured.source, agent: agentName, tool: action.tool }] }),
      },
    };
    await store.messages.add(record);
    await store.conversations.update(owner, action.conversationId, { updatedAt: record.createdAt });
    const followUp = await this.continueRun(
      auth,
      action,
      out.ok ? { status: 'completed', ...(out.structured && { structured: out.structured }) } : { status: 'failed', ...(errorMessage && { errorMessage }) },
    );
    return { confirmation: toConfirmation(updated), message: toMessageDTO(record, auth.user), followUp };
  }
}
