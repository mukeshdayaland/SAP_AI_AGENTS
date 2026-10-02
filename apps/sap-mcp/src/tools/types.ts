import type { ToolRisk, UIComponent } from '@prowess/contracts';
import type { z } from 'zod';
import type { Amount, SapCallContext, SapGateway } from '../sap/model.js';

/** Tool domains follow SAP modules, so each module can be deployed as its own MCP service. */
export const BUSINESS_DOMAINS = ['sd', 'credit', 'ar', 'ap', 'gl', 'mm', 'pm', 'shared'] as const;
export type Domain = (typeof BUSINESS_DOMAINS)[number] | 'system';

/** What a tool returns. The orchestrator separates model-facing data from UI-facing parts. */
export interface ToolResultPayload {
  /** Compact facts for the model. Treated by the orchestrator as untrusted data. */
  data: Record<string, unknown>;
  /** UI component candidates — re-validated by the orchestrator before reaching the browser. */
  components?: UIComponent[];
  source?: { system: string; objectType: string; objectId: string; retrievedAt: string; mock: boolean };
  /** Suggested follow-up prompts (never direct executions). */
  followUps?: { label: string; prompt: string }[];
  /** Named values (document numbers, statuses) that later steps of a workflow run can refer to. */
  outputs?: Record<string, string>;
}

/** Human-readable description of a pending write, shown on the confirmation card. */
export interface ActionPreview {
  action: string;
  businessObject: { type: string; id: string };
  proposedChange: string;
  impact: string;
}

export interface ToolContext {
  sap: SapCallContext;
  gateway: SapGateway;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  domain: Domain;
  title: string;
  description: string;
  risk: ToolRisk;
  operation: 'SAP_READ' | 'SAP_WRITE' | 'NONE';
  /** Short progress label shown in the UI ("Retrieving invoice"). */
  statusLabel: string;
  input: S;
  /** Hidden from models; only the orchestrator may call it. */
  internal?: boolean;
  /** Required for every non-READ tool. Must not change SAP state. */
  preview?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ActionPreview>;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResultPayload>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export const fmt = (m: Amount) =>
  `${m.currency} ${m.amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const now = () => new Date().toISOString();
