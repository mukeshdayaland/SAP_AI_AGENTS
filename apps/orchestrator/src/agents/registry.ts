import type { AgentDescriptor, ModelTierDescriptor, UserProfile } from '@prowess/contracts';
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

  all(): AgentDefinition[] {
    return this.catalog.agents.filter((a) => a.enabled);
  }

  forUser(user: UserProfile): AgentDefinition[] {
    return this.all().filter((a) => hasAnyRole(user, a.requiredRoles));
  }

  resolve(user: UserProfile, id?: string): AgentDefinition {
    const agent = this.all().find((a) => a.id === (id ?? this.catalog.defaultAgent));
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

  toolsFor(agent: AgentDefinition, tools: McpToolInfo[]): McpToolInfo[] {
    return tools.filter((t) => !t.internal && isToolAllowed(agent, t.name));
  }

  describeAgents(user: UserProfile): AgentDescriptor[] {
    return this.forUser(user).map((a) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, domain: a.domain }));
  }

  describeTiers(user: UserProfile): ModelTierDescriptor[] {
    const technical = hasRole(user, 'AI_POWER_USER') || hasRole(user, 'AI_ADMIN');
    return this.router.tiers
      .filter((t) => hasAnyRole(user, t.requiredRoles as never) && this.router.isTierAvailable(t.id))
      .map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        ...(technical && { technical: this.router.resolveTargets(t.id).map((x) => ({ provider: x.provider, model: x.model })) }),
      }));
  }
}

export function isToolAllowed(agent: Pick<AgentDefinition, 'allowedTools'>, toolName: string): boolean {
  return agent.allowedTools.some((pattern) => (pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName));
}
