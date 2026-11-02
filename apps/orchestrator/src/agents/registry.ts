import { describeChoices, type AgentDescriptor, type ModelTierDescriptor, type StarterAction, type UiLocale, type UserProfile } from '@prowess/contracts';
import type { ModelRouter } from '@prowess/llm';
import { hasAnyRole, hasRole } from '../auth/types.js';
import type { AgentCatalog, AgentDefinition } from '../config/catalog.js';
import { AppError } from '../errors/app-error.js';
import type { McpToolInfo } from '../mcp/gateway.js';

/** Resolves which agents, tools and model tiers a user may use. */
export class AgentRegistry {
  constructor(
    private readonly catalog: AgentCatalog,
    private readonly router: ModelRouter,
  ) {}

  get defaultAgentId() {
    return this.catalog.defaultAgent;
  }

  get starters() {
    return this.catalog.starters;
  }

  /** Starter cards in the interface language, prompt included; text not translated falls back to English. */
  describeStarters(locale: UiLocale = 'en'): StarterAction[] {
    return this.catalog.starters.map(({ i18n, ...s }) => ({ ...s, label: i18n[locale]?.label ?? s.label, description: i18n[locale]?.description ?? s.description, prompt: i18n[locale]?.prompt ?? s.prompt }));
  }

  all(): AgentDefinition[] {
    return this.catalog.agents.filter((a) => a.enabled);
  }

  forUser(user: UserProfile): AgentDefinition[] {
    return this.all().filter((a) => hasAnyRole(user, a.requiredRoles));
  }

  resolve(user: UserProfile, id?: string): AgentDefinition {
    const wanted = id ?? this.catalog.defaultAgent;
    const agent = this.all().find((a) => a.id === wanted) ?? this.all().find((a) => a.aliases.includes(wanted));
    if (!agent) throw AppError.validation('Unknown agent.');
    if (!hasAnyRole(user, agent.requiredRoles)) throw AppError.forbidden(`You do not have access to the ${agent.name}.`);
    return agent;
  }

  /** Tiers the agent supports, the user is entitled to, and that have at least one configured provider. */
  tiersFor(user: UserProfile, agent: AgentDefinition): string[] {
    return agent.modelTiers.filter((id) => {
      const tier = this.router.tier(id);
      return tier && hasAnyRole(user, tier.requiredRoles as never) && this.router.isTierAvailable(id);
    });
  }

  resolveTier(user: UserProfile, agent: AgentDefinition, requested?: string): string {
    const allowed = this.tiersFor(user, agent);
    if (requested) {
      if (!allowed.includes(requested)) throw AppError.forbidden('That model option is not available to you.');
      return requested;
    }
    const first = allowed[0];
    if (!first) throw new AppError('NO_MODEL_AVAILABLE', 'No AI model is currently available for this agent.', 'CONFIGURATION');
    return first;
  }

  /** The agent's tools that this user may be offered: a tool can ask for a role of its own on top of the agent's. */
  toolsFor(agent: AgentDefinition, tools: McpToolInfo[], user: UserProfile): McpToolInfo[] {
    return tools
      .filter((t) => !t.internal && isToolAllowed(agent, t.name) && (!t.requiredRole || hasRole(user, t.requiredRole)))
      .flatMap((t) => scopeToAgent(agent, t) ?? []);
  }

  describeAgents(user: UserProfile, locale: UiLocale = 'en'): AgentDescriptor[] {
    return this.forUser(user).map((a) => ({ id: a.id, name: a.i18n[locale]?.name ?? a.name, description: a.i18n[locale]?.description ?? a.description, icon: a.icon, domain: a.domain }));
  }

  describeTiers(user: UserProfile, locale: UiLocale = 'en'): ModelTierDescriptor[] {
    const technical = hasRole(user, 'AI_POWER_USER') || hasRole(user, 'AI_ADMIN');
    return this.router.tiers
      .filter((t) => hasAnyRole(user, t.requiredRoles as never) && this.router.isTierAvailable(t.id))
      .map((t) => ({
        id: t.id,
        label: t.i18n?.[locale]?.label ?? t.label,
        description: t.i18n?.[locale]?.description ?? t.description,
        ...(technical && { technical: this.router.resolveTargets(t.id).map((x) => ({ provider: x.provider, model: x.model })) }),
      }));
  }
}

/**
 * The tool as this agent is offered it: an argument with choices keeps only the options of the
 * tool domains the agent covers in full (`ar_*`), and the description lists only those. A tool
 * left without options is not offered. Calls are not restricted by this; it saves tokens.
 */
export function scopeToAgent<T extends { description: string; inputSchema: Record<string, unknown>; choices?: McpToolInfo['choices'] }>(
  agent: Pick<AgentDefinition, 'allowedTools'>,
  tool: T,
): T | undefined {
  const { choices } = tool;
  if (!choices) return tool;
  const options = choices.options.filter((o) => o.domains.some((d) => agent.allowedTools.includes(`${d}_*`)));
  if (!options.length) return undefined;
  if (options.length === choices.options.length) return tool;
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return {
    ...tool,
    description: describeChoices(choices, options),
    inputSchema: { ...tool.inputSchema, properties: { ...properties, [choices.param]: { ...properties[choices.param], enum: options.map((o) => o.value) } } },
  };
}

export function isToolAllowed(agent: Pick<AgentDefinition, 'allowedTools'>, toolName: string): boolean {
  return agent.allowedTools.some((pattern) => (pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName));
}
