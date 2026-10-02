import type {
  AgentResponse,
  AttachmentRef,
  ConfirmationRequest,
  DeploymentEnvironment,
  Feedback,
  MessageRole,
  PublicError,
  ToolRisk,
  WorkflowRunStatus,
  WorkflowStepState,
} from '@prowess/contracts';

/**
 * Persistence ports. Every read/write of user-owned data is scoped by
 * `owner` so an ID alone can never retrieve another user's data — isolation
 * is enforced in the storage query itself, not only in controllers.
 */

export interface Owner {
  userId: string;
  tenantId: string;
}

export interface ConversationRecord extends Owner {
  id: string;
  title: string;
  agent: string;
  modelTier: string;
  createdAt: string;
  updatedAt: string;
  /** Rolling summary of turns older than `summaryUntil` (context-window management). */
  summary?: string;
  summaryUntil?: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  agent?: string;
  modelTier?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  status: 'complete' | 'error' | 'stopped';
  attachments?: AttachmentRef[];
  response?: Omit<AgentResponse, 'message'>;
  feedback?: Feedback;
  feedbackComment?: string;
  error?: PublicError;
  /** Condensed tool results kept for follow-up turns (never shown to users). */
  toolContext?: string;
}

export interface AttachmentRecord extends Owner {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  extractedText?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ActionPreviewRecord {
  action: string;
  businessObject: { type: string; id: string };
  proposedChange: string;
  impact: string;
}

export interface PendingActionRecord extends Owner {
  id: string;
  conversationId: string;
  messageId: string;
  agent: string;
  tool: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  environment: DeploymentEnvironment;
  targetSystem: string;
  risk: ToolRisk;
  preview: ActionPreviewRecord;
  status: ConfirmationRequest['status'];
  createdAt: string;
  expiresAt: string;
  resultMessageId?: string;
  /** Set when the action is a step of a workflow run; the run resumes once the action is resolved. */
  runId?: string;
  stepId?: string;
}

export interface WorkflowStepRecord {
  id: string;
  state: WorkflowStepState;
  /** One-line outcome shown on the run card. */
  detail?: string;
  /** Values the step's tool published for later steps (document numbers, statuses). */
  outputs?: Record<string, string>;
  actionId?: string;
}

export interface WorkflowRunRecord extends Owner {
  id: string;
  workflow: string;
  title: string;
  conversationId: string;
  input: Record<string, string>;
  status: WorkflowRunStatus;
  reason?: string;
  steps: WorkflowStepRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  userId: string;
  tenantId: string;
  agent: string;
  provider: string;
  model: string;
  modelTier: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  day: string;
  at: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface Store {
  conversations: {
    create(c: ConversationRecord): Promise<void>;
    get(owner: Owner, id: string): Promise<ConversationRecord | null>;
    list(owner: Owner, limit: number): Promise<ConversationRecord[]>;
    update(owner: Owner, id: string, patch: Partial<Pick<ConversationRecord, 'title' | 'agent' | 'modelTier' | 'updatedAt' | 'summary' | 'summaryUntil'>>): Promise<boolean>;
    delete(owner: Owner, id: string): Promise<boolean>;
    purgeUpdatedBefore(cutoff: string): Promise<number>;
  };
  messages: {
    add(m: MessageRecord): Promise<void>;
    /** Caller must have verified conversation ownership. */
    list(conversationId: string): Promise<MessageRecord[]>;
    update(conversationId: string, id: string, patch: Partial<MessageRecord>): Promise<boolean>;
    deleteFrom(conversationId: string, createdAtInclusive: string): Promise<number>;
  };
  attachments: {
    create(a: AttachmentRecord): Promise<void>;
    get(owner: Owner, id: string): Promise<AttachmentRecord | null>;
    delete(owner: Owner, id: string): Promise<boolean>;
    listExpired(now: string): Promise<AttachmentRecord[]>;
    deleteById(id: string): Promise<void>;
  };
  actions: {
    create(a: PendingActionRecord): Promise<void>;
    get(owner: Owner, id: string): Promise<PendingActionRecord | null>;
    /** Atomic compare-and-set on status; returns false if the status had changed. */
    transition(owner: Owner, id: string, from: PendingActionRecord['status'], to: PendingActionRecord['status'], patch?: Partial<PendingActionRecord>): Promise<boolean>;
  };
  runs: {
    create(r: WorkflowRunRecord): Promise<void>;
    get(owner: Owner, id: string): Promise<WorkflowRunRecord | null>;
    update(owner: Owner, r: WorkflowRunRecord): Promise<boolean>;
  };
  usage: {
    record(u: UsageRecord): Promise<void>;
    totalsForUser(userId: string, day: string): Promise<UsageTotals>;
    totalsForAgent(agent: string, day: string): Promise<UsageTotals>;
    summary(sinceDay: string): Promise<{ day: string; provider: string; modelTier: string; agent: string; inputTokens: number; outputTokens: number; requests: number }[]>;
  };
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
