import { z } from 'zod';
import type { UIComponent, WorkflowRunComponent } from './components.js';

/* ------------------------------------------------------------------ */
/* Identity & authorization                                            */
/* ------------------------------------------------------------------ */

/**
 * Application roles. These govern access to Prowess AI features only.
 * They NEVER grant SAP business authorization — S/4HANA evaluates its own
 * authorizations for every call made on the user's behalf.
 */
export const APP_ROLES = ['AI_USER', 'AI_POWER_USER', 'AI_ADMIN', 'AI_AUDITOR'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const ENVIRONMENTS = ['DEV', 'QA', 'PROD'] as const;
export type DeploymentEnvironment = (typeof ENVIRONMENTS)[number];

export interface UserProfile {
  id: string;
  displayName: string;
  email?: string;
  tenantId: string;
  roles: AppRole[];
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** Ordered from least to most consequential. */
export const TOOL_RISKS = ['READ', 'LOW_RISK_WRITE', 'BUSINESS_WRITE', 'HIGH_IMPACT'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

export function riskRank(risk: ToolRisk): number {
  return TOOL_RISKS.indexOf(risk);
}

/** Risks that must never execute without explicit human confirmation. */
export function requiresConfirmation(risk: ToolRisk): boolean {
  return riskRank(risk) >= riskRank('BUSINESS_WRITE');
}

/** MCP `_meta` keys used by Prowess MCP servers to describe tools. */
export const MCP_META = {
  risk: 'prowess/risk',
  domain: 'prowess/domain',
  targetSystem: 'prowess/targetSystem',
  operation: 'prowess/operation',
  statusLabel: 'prowess/statusLabel',
} as const;

/* ------------------------------------------------------------------ */
/* Agent response contract                                             */
/* ------------------------------------------------------------------ */

export interface SourceReference {
  id: string;
  system: string;
  objectType: string;
  objectId: string;
  retrievedAt: string;
  agent: string;
  tool: string;
  mock: boolean;
}

/** A follow-up the user can trigger. Always a *prompt*, never direct execution. */
export interface AgentAction {
  id: string;
  label: string;
  prompt: string;
}

export type StepState = 'running' | 'done' | 'error' | 'skipped';

export interface ExecutionStep {
  id: string;
  label: string;
  state: StepState;
}

/** Safe operational metadata. Never contains prompts, reasoning or payloads. */
export interface ToolExecutionMetadata {
  id: string;
  agent: string;
  tool: string;
  system: string;
  risk: ToolRisk;
  durationMs: number;
  status: 'success' | 'error' | 'denied' | 'pending_confirmation';
  correlationId: string;
  mock: boolean;
}

export interface ExecutionMetadata {
  correlationId: string;
  agent: string;
  modelTier: string;
  /** Provider/deployment are shown only to power users/admins. */
  provider?: string;
  model?: string;
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  tools: ToolExecutionMetadata[];
}

export interface ConfirmationRequest {
  id: string;
  action: string;
  targetSystem: string;
  environment: DeploymentEnvironment;
  businessObject: { type: string; id: string };
  proposedChange: string;
  impact: string;
  risk: ToolRisk;
  expiresAt: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed' | 'completed';
}

export interface AgentResponse {
  message: string;
  components?: UIComponent[];
  sources?: SourceReference[];
  actions?: AgentAction[];
  confirmations?: ConfirmationRequest[];
  execution?: ExecutionMetadata;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'assistant';
export type Feedback = 'up' | 'down';

export interface AttachmentRef {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MessageDTO {
  id: string;
  role: MessageRole;
  content: string;
  agent?: string;
  modelTier?: string;
  createdAt: string;
  status: 'complete' | 'error' | 'stopped';
  attachments?: AttachmentRef[];
  response?: Omit<AgentResponse, 'message'>;
  feedback?: Feedback;
  error?: PublicError;
}

export interface ConversationSummary {
  id: string;
  title: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageDTO[];
}

/* ------------------------------------------------------------------ */
/* Workflow runs                                                       */
/* ------------------------------------------------------------------ */

/** A configured multi-step process a user may start. */
export interface WorkflowDescriptor {
  id: string;
  name: string;
  description: string;
  input: { name: string; label: string }[];
  steps: { id: string; title: string; agent: string }[];
}

export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunComponent>['data'];
export type WorkflowRunStatus = WorkflowRunSnapshot['status'];
export type WorkflowStepState = WorkflowRunSnapshot['steps'][number]['state'];

export interface WorkflowRunDTO extends WorkflowRunSnapshot {
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Workspace configuration exposed to the UI                           */
/* ------------------------------------------------------------------ */

export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  icon: string;
  domain: string;
}

export interface ModelTierDescriptor {
  id: string;
  label: string;
  description: string;
  /** Present only for users allowed to see technical details. */
  technical?: { provider: string; model: string }[];
}

export interface StarterAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
  agent: string;
  icon: string;
}

export interface WorkspaceConfig {
  product: { name: string; subtitle: string };
  environment: DeploymentEnvironment;
  user: UserProfile;
  agents: AgentDescriptor[];
  modelTiers: ModelTierDescriptor[];
  defaultAgent: string;
  defaultModelTier: string;
  starters: StarterAction[];
  features: {
    attachments: boolean;
    feedback: boolean;
    technicalPanel: boolean;
    admin: boolean;
    audit: boolean;
  };
  uploads: { maxBytes: number; accept: string[] };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export const ERROR_CATEGORIES = [
  'VALIDATION',
  'AUTHENTICATION',
  'AUTHORIZATION',
  'NOT_FOUND',
  'RATE_LIMIT',
  'QUOTA',
  'MODEL_PROVIDER',
  'TOOL',
  'SAP',
  'CONFIGURATION',
  'INTERNAL',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** The only error shape ever returned to clients. */
export interface PublicError {
  code: string;
  message: string;
  correlationId: string;
  reference: string;
  retryable: boolean;
  category: ErrorCategory;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(16_000),
  agent: z.string().min(1).max(64).optional(),
  modelTier: z.string().min(1).max(32).optional(),
  attachments: z.array(z.string().min(1).max(64)).max(5).optional(),
  /** When set, replaces the assistant reply to this user message. */
  regenerateMessageId: z.string().min(1).max(64).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const FeedbackRequestSchema = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().max(2_000).optional(),
});

export const RenameConversationSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const StartRunSchema = z.object({
  input: z.record(z.string().min(1).max(40), z.string().max(200)),
});

export const ConfirmActionSchema = z.object({
  /** Explicit acknowledgement required for PROD writes. */
  acknowledgeEnvironment: z.enum(ENVIRONMENTS).optional(),
});
