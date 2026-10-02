import { M, type Logger } from '@prowess/observability';
import { ProviderError } from './errors.js';
import type { LLMChunk, LLMProvider, LLMRequest, LLMResponse, ProviderId, TokenUsage } from './types.js';
import { collect } from './types.js';

/**
 * Business-facing model tiers ("Standard", "Advanced", "Private") mapped to
 * ordered provider targets. Users never pick raw models; administrators
 * control the mapping through configuration.
 */
export interface ModelTarget {
  provider: ProviderId;
  /** Provider-specific model name, deployment name or deployment ID. */
  model: string;
}

export interface ModelTier {
  id: string;
  label: string;
  description: string;
  requiredRoles: string[];
  /** Try the next target when one fails before producing output. */
  fallback: boolean;
  /** Restrict to providers whose inference stays inside the SAP landscape. */
  privateOnly?: boolean;
  maxOutputTokens: number;
  maxContextTokens: number;
  temperature?: number;
  targets: ModelTarget[];
}

export interface ModelCatalog {
  tiers: ModelTier[];
}

export interface RouterOptions {
  /** Moves this provider's targets to the front of every tier (`DEFAULT_LLM_PROVIDER`). */
  preferredProvider?: ProviderId;
  logger?: Logger;
}

export interface RoutedSelection {
  tier: string;
  provider: ProviderId;
  model: string;
  attempt: number;
}

export interface RoutedStreamResult {
  selection: RoutedSelection;
  usage: TokenUsage;
}

export class ModelRouter {
  constructor(
    private readonly providers: ReadonlyMap<ProviderId, LLMProvider>,
    private readonly catalog: ModelCatalog,
    private readonly opts: RouterOptions = {},
  ) {}

  get tiers(): readonly ModelTier[] {
    return this.catalog.tiers;
  }

  tier(id: string): ModelTier | undefined {
    return this.catalog.tiers.find((t) => t.id === id);
  }

  /** Targets that are configured, permitted by tier policy, and ordered by preference. */
  resolveTargets(tierId: string): ModelTarget[] {
    const tier = this.tier(tierId);
    if (!tier) throw new ProviderError('router', 'configuration', `Unknown model tier "${tierId}"`);
    const available = tier.targets.filter((t) => {
      const p = this.providers.get(t.provider);
      return p && (!tier.privateOnly || p.private);
    });
    const preferred = this.opts.preferredProvider;
    if (!preferred) return available;
    return [...available.filter((t) => t.provider === preferred), ...available.filter((t) => t.provider !== preferred)];
  }

  isTierAvailable(tierId: string): boolean {
    return this.resolveTargets(tierId).length > 0;
  }

  /**
   * Streams from the first healthy target. Falls back to the next target only
   * when the tier allows it, the error is retryable, and nothing has been
   * emitted yet — a partially streamed answer is never silently replaced.
   */
  async *stream(
    tierId: string,
    request: Omit<LLMRequest, 'model'>,
    onSelect?: (selection: RoutedSelection) => void,
  ): AsyncGenerator<LLMChunk, RoutedStreamResult> {
    const tier = this.tier(tierId)!;
    const targets = this.resolveTargets(tierId);
    if (!targets.length) {
      throw new ProviderError('router', 'configuration', `No configured provider is permitted for tier "${tierId}"`);
    }

    let lastError: unknown;
    for (const [attempt, target] of targets.entries()) {
      const provider = this.providers.get(target.provider)!;
      const selection: RoutedSelection = { tier: tierId, provider: target.provider, model: target.model, attempt };
      const started = Date.now();
      let emitted = false;
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      try {
        onSelect?.(selection);
        for await (const chunk of provider.stream({
          maxOutputTokens: tier.maxOutputTokens,
          ...(tier.temperature !== undefined && { temperature: tier.temperature }),
          ...request,
          model: target.model,
        })) {
          if (chunk.type === 'usage') usage = chunk.usage;
          else emitted = true;
          yield chunk;
        }
        this.record(target, 'success', Date.now() - started, usage);
        return { selection, usage };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ProviderError && err.retryable;
        this.record(target, err instanceof ProviderError ? err.kind : 'error', Date.now() - started);
        const next = targets[attempt + 1];
        const canFallback = tier.fallback && retryable && !emitted && next !== undefined;
        this.opts.logger?.warn('llm.provider_failed', {
          provider: target.provider,
          model: target.model,
          tier: tierId,
          kind: err instanceof ProviderError ? err.kind : 'unknown',
          error: (err as Error).message,
          fallbackTo: canFallback ? next.provider : undefined,
        });
        if (!canFallback) throw err;
      }
    }
    throw lastError;
  }

  async complete(tierId: string, request: Omit<LLMRequest, 'model'>): Promise<LLMResponse & { selection?: RoutedSelection }> {
    let selection: RoutedSelection | undefined;
    const result = await collect(
      this.stream(tierId, request, (s) => {
        selection = s;
      }),
    );
    return { ...result, ...(selection && { selection }) };
  }

  async health(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.providers.entries()].map(async ([id, p]) => {
        const ok = await p.healthCheck().catch(() => false);
        M.providerUp().set({ provider: id }, ok ? 1 : 0);
        return [id, ok] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private record(target: ModelTarget, outcome: string, durationMs: number, usage?: TokenUsage) {
    const labels = { provider: target.provider, model: target.model };
    M.llmRequests().inc({ ...labels, outcome });
    M.llmDuration().observe(labels, durationMs);
    if (usage) {
      M.llmTokens().inc({ ...labels, direction: 'input' }, usage.inputTokens);
      M.llmTokens().inc({ ...labels, direction: 'output' }, usage.outputTokens);
    }
  }
}
