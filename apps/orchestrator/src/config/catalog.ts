import { readFileSync } from 'node:fs';
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
    if (!ids.has(cat.defaultAgent)) ctx.addIssue({ code: 'custom', message: `defaultAgent "${cat.defaultAgent}" is not defined` });
    for (const s of cat.starters) if (!ids.has(s.agent)) ctx.addIssue({ code: 'custom', message: `Starter "${s.id}" references unknown agent` });
  });

export type AgentDefinition = z.infer<typeof AgentSchema>;
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Loads and validates catalogs; invalid configuration fails startup. */
export function loadCatalogs(configDir: string): { models: ModelCatalog; agents: AgentCatalog } {
  const models = ModelCatalogSchema.parse(readJson(resolve(configDir, 'models.json')));
  const agents = AgentCatalogSchema.parse(readJson(resolve(configDir, 'agents.json')));
  const tierIds = new Set(models.tiers.map((t) => t.id));
  for (const a of agents.agents) {
    for (const t of a.modelTiers) if (!tierIds.has(t)) throw new Error(`Agent ${a.id} references unknown model tier ${t}`);
  }
  return { models, agents };
}
