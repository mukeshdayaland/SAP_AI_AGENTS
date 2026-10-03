import type { ToolRisk } from '@prowess/contracts';
import { hashArguments } from '@prowess/security';
import type { AuditTrail } from '../audit/audit.js';
import type { OrchestratorConfig } from '../config/env.js';
import type { McpSession, McpToolInfo } from '../mcp/gateway.js';
import type { Owner, PendingActionRecord, Store } from '../persistence/types.js';
import { newId } from './mappers.js';

export interface PendingActionRequest {
  owner: Owner;
  conversationId: string;
  /** The assistant message whose confirmation card represents this action. */
  messageId: string;
  agent: string;
  tool: McpToolInfo;
  risk: ToolRisk;
  arguments: Record<string, unknown>;
  allTools: McpToolInfo[];
  session: McpSession;
  signal?: AbortSignal;
  /** Set when the write is a step of a workflow run. */
  run?: { runId: string; stepId: string };
}

export type PendingActionResult =
  | { ok: true; action: PendingActionRecord; durationMs: number; mock: boolean }
  | { ok: false; message: string; code?: string; durationMs: number };

/**
 * Turns a requested SAP write into a pending action awaiting human
 * confirmation. Nothing is written to SAP here: the MCP server only builds a
 * read-only preview and normalizes the arguments that will later be hashed
 * into the confirmation assertion.
 */
export async function preparePendingAction(deps: { store: Store; audit: AuditTrail; config: OrchestratorConfig }, req: PendingActionRequest): Promise<PendingActionResult> {
  const preview = req.allTools.find((t) => t.name === 'system_previewAction' && t.serverId === req.tool.serverId);
  const out = preview ? await req.session.callTool(preview, { tool: req.tool.name, arguments: req.arguments }, req.signal) : undefined;
  if (!out?.ok) return { ok: false, message: out?.errorMessage ?? 'This action cannot be prepared right now.', ...(out?.errorCode && { code: out.errorCode }), durationMs: out?.durationMs ?? 0 };

  const data = (out.structured?.data ?? {}) as {
    preview: PendingActionRecord['preview'];
    normalizedArguments: Record<string, unknown>;
    targetSystem: string;
    mock: boolean;
  };
  const now = Date.now();
  const action: PendingActionRecord = {
    id: newId('a'),
    ...req.owner,
    conversationId: req.conversationId,
    messageId: req.messageId,
    agent: req.agent,
    tool: req.tool.name,
    arguments: data.normalizedArguments,
    argumentsHash: hashArguments(data.normalizedArguments),
    environment: deps.config.environment,
    targetSystem: data.targetSystem,
    risk: req.risk,
    preview: data.preview,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + deps.config.confirmations.ttlSeconds * 1_000).toISOString(),
    ...req.run,
  };
  await deps.store.actions.create(action);
  deps.audit.record({
    type: 'SAP_WRITE_REQUESTED',
    ...req.owner,
    agent: req.agent,
    tool: req.tool.name,
    targetSystem: action.targetSystem,
    operation: 'SAP_WRITE',
    status: 'pending',
    details: {
      actionId: action.id,
      objectType: action.preview.businessObject.type,
      objectId: action.preview.businessObject.id,
      risk: req.risk,
      ...(req.run && { runId: req.run.runId }),
    },
  });
  return { ok: true, action, durationMs: out.durationMs, mock: data.mock };
}
