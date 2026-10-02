import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROLES } from '@prowess/contracts';
import { PROVIDER_IDS, type ModelCatalog } from '@prowess/llm';
import { z } from 'zod';

const role = z.enum(APP_ROLES);

const TierSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  label: z.string().min(1).max(40),
  description: z.string().max(200),
  requiredRoles: z.array(role).min(1),
  fallback: z.boolean(),
  privateOnly: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().max(64_000),
  maxContextTokens: z.number().int().positive().max(1_000_000),
  temperature: z.number().min(0).max(2).optional(),
  targets: z.array(z.object({ provider: z.enum(PROVIDER_IDS), model: z.string().min(1).max(200) })).min(1),
});

export const ModelCatalogSchema = z.object({ tiers: z.array(TierSchema).min(1) });

const AgentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(200),
  icon: z.string().max(30),
  domain: z.string().max(30),
  allowedTools: z.array(z.string().regex(/^[a-z]+_([A-Za-z]+|\*)$/)).min(1),
  modelTiers: z.array(z.string()).min(1),
  requiredRoles: z.array(role).min(1),
  instructions: z.string().max(4_000),
  enabled: z.boolean().default(true),
  /** Former ids of this agent. Stored conversations that reference one resolve to this agent. */
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)).default([]),
});

const StarterSchema = z.object({
  id: z.string(),
  label: z.string().max(60),
  description: z.string().max(120),
  prompt: z.string().max(500),
  agent: z.string(),
  icon: z.string().max(30),
});

export const AgentCatalogSchema = z
  .object({ defaultAgent: z.string(), agents: z.array(AgentSchema).min(1), starters: z.array(StarterSchema).default([]) })
  .superRefine((cat, ctx) => {
    const ids = new Set(cat.agents.map((a) => a.id));
    const names = cat.agents.flatMap((a) => [a.id, ...a.aliases]);
    for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) ctx.addIssue({ code: 'custom', message: `Agent id or alias "${name}" is used more than once` });
    if (!ids.has(cat.defaultAgent)) ctx.addIssue({ code: 'custom', message: `defaultAgent "${cat.defaultAgent}" is not defined` });
    for (const s of cat.starters) if (!ids.has(s.agent)) ctx.addIssue({ code: 'custom', message: `Starter "${s.id}" references unknown agent` });
  });

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);
/** `${input.name}` or `${steps.stepId.outputName}`, resolved against the run when a step starts. */
const ConditionSchema = z.object({ value: z.string().max(120), equals: z.string().max(60) });

const WorkflowStepSchema = z.object({
  id: name,
  title: z.string().min(1).max(120),
  /** The module agent that owns the step. Its tool allow-list and required roles apply. */
  agent: z.string(),
  tool: z.string().regex(/^[a-z]+_[A-Za-z]+$/),
  arguments: z.record(name, z.string().max(200)).default({}),
  /** The step is skipped when any condition holds (for example: the delivery already exists). */
  skipWhen: z.array(ConditionSchema).default([]),
  /** After the step, the run stops as "blocked" when any condition holds. */
  haltWhen: z.array(ConditionSchema.extend({ reason: z.string().min(1).max(400) })).default([]),
});

const WorkflowSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    name: z.string().min(1).max(60),
    description: z.string().max(300),
    /** Agents whose chats may start this workflow. */
    agents: z.array(z.string()).min(1),
    /** What the run is about, shown in its title: `Sales order ${input.salesOrder}`. */
    subject: z.string().max(120),
    input: z.array(z.object({ name, label: z.string().min(1).max(60), pattern: z.string().max(120) })).min(1),
    steps: z.array(WorkflowStepSchema).min(1).max(30),
  })
  .superRefine((w, ctx) => {
    const ids = w.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Workflow "${w.id}" has duplicate step ids` });
    for (const i of w.input) {
      try {
        new RegExp(i.pattern);
      } catch {
        ctx.addIssue({ code: 'custom', message: `Workflow "${w.id}": input "${i.name}" has an invalid pattern` });
      }
    }
  });

export const WorkflowCatalogSchema = z.object({ workflows: z.array(WorkflowSchema).default([]) });

export type AgentDefinition = z.infer<typeof AgentSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type WorkflowStepDefinition = z.infer<typeof WorkflowStepSchema>;
export type WorkflowCatalog = z.infer<typeof WorkflowCatalogSchema>;
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Loads and validates catalogs; invalid configuration fails startup. */
export function loadCatalogs(configDir: string): { models: ModelCatalog; agents: AgentCatalog; workflows: WorkflowCatalog } {
  const models = ModelCatalogSchema.parse(readJson(resolve(configDir, 'models.json')));
  const agents = AgentCatalogSchema.parse(readJson(resolve(configDir, 'agents.json')));
  const tierIds = new Set(models.tiers.map((t) => t.id));
  for (const a of agents.agents) {
    for (const t of a.modelTiers) if (!tierIds.has(t)) throw new Error(`Agent ${a.id} references unknown model tier ${t}`);
  }
  const workflowFile = resolve(configDir, 'workflows.json');
  const workflows = WorkflowCatalogSchema.parse(existsSync(workflowFile) ? readJson(workflowFile) : {});
  const agentIds = new Set(agents.agents.map((a) => a.id));
  for (const w of workflows.workflows) {
    for (const id of [...w.agents, ...w.steps.map((s) => s.agent)]) {
      if (!agentIds.has(id)) throw new Error(`Workflow ${w.id} references unknown agent ${id}`);
    }
  }
  return { models, agents, workflows };
}
