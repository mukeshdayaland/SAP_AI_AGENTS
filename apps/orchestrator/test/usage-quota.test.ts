import { MockProvider, type LLMChunk, type LLMProvider, type LLMRequest, type ProviderId } from '@prowess/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/memory.js';
import type { UsageRecord } from '../src/persistence/types.js';
import { CACHED_INPUT_WEIGHT, QuotaService, quotaTokens, today } from '../src/usage/limits.js';
import { startStack, USERS } from './harness.js';

const row = (u: Partial<UsageRecord>): UsageRecord => ({
  userId: 'u1',
  tenantId: 't',
  agent: 'fico',
  provider: 'sap-ai-core',
  model: 'gpt-5.5',
  modelTier: 'standard',
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 1,
  day: today(),
  at: new Date().toISOString(),
  ...u,
});

describe('quota weighting of prompt-cache hits', () => {
  it('counts cached input at a tenth and everything else at full weight', () => {
    expect(CACHED_INPUT_WEIGHT).toBe(0.1);
    expect(quotaTokens({ inputTokens: 10_000, outputTokens: 500, cachedInputTokens: 0, requests: 1 })).toBe(10_500);
    expect(quotaTokens({ inputTokens: 10_000, outputTokens: 500, cachedInputTokens: 8_000, requests: 1 })).toBe(2_000 + 800 + 500);
    // A provider reporting more cached than total input never makes the charge negative.
    expect(quotaTokens({ inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 5_000, requests: 1 })).toBe(100);
  });

  it('lets a user with mostly cached input through where raw counting would block them', async () => {
    const limits = { dailyTokensPerUser: 500_000, dailyTokensPerAgent: 10_000_000 };
    const cachedStore = new MemoryStore();
    await cachedStore.usage.record(row({ inputTokens: 900_000, cachedInputTokens: 800_000, outputTokens: 10_000 }));
    await expect(new QuotaService(cachedStore, limits).assertWithinQuota('u1', 'fico')).resolves.toBeUndefined();
    // Reporting keeps the raw input count.
    expect(await cachedStore.usage.totalsForUser('u1', today())).toMatchObject({ inputTokens: 900_000, cachedInputTokens: 800_000 });

    const rawStore = new MemoryStore();
    await rawStore.usage.record(row({ inputTokens: 900_000, outputTokens: 10_000 }));
    await expect(new QuotaService(rawStore, limits).assertWithinQuota('u1', 'fico')).rejects.toMatchObject({ code: 'USER_QUOTA_EXCEEDED' });
  });

  it('applies the same weighting to the per-agent limit', async () => {
    const store = new MemoryStore();
    await store.usage.record(row({ userId: 'a', inputTokens: 600_000, cachedInputTokens: 600_000 }));
    await store.usage.record(row({ userId: 'b', inputTokens: 600_000, cachedInputTokens: 0 }));
    const quota = new QuotaService(store, { dailyTokensPerUser: 10_000_000, dailyTokensPerAgent: 700_000 });
    await expect(quota.assertWithinQuota('c', 'fico')).resolves.toBeUndefined();
    await store.usage.record(row({ userId: 'b', inputTokens: 50_000 }));
    await expect(quota.assertWithinQuota('c', 'fico')).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXCEEDED' });
  });
});

describe('recording cached input tokens from a chat', () => {
  /** Reports most of every call's input as a cache hit, like gpt-5.5 re-reading the tool + system prefix. */
  class CachingProvider extends MockProvider {
    readonly reported = { input: 0, cached: 0 };
    override async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
      for await (const chunk of super.stream(req)) {
        if (chunk.type !== 'usage') {
          yield chunk;
          continue;
        }
        const cachedInputTokens = Math.floor(chunk.usage.inputTokens * 0.8);
        this.reported.input += chunk.usage.inputTokens;
        this.reported.cached += cachedInputTokens;
        yield { type: 'usage', usage: { ...chunk.usage, cachedInputTokens } };
      }
    }
  }
  const provider = new CachingProvider();
  let stack: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    stack = await startStack({ providers: new Map<ProviderId, LLMProvider>([['mock', provider]]) });
  });
  afterAll(() => stack.stop());

  it('stores raw input tokens unchanged alongside the cached share', async () => {
    const res = await stack.chat(USERS.jordan, { message: 'Why is invoice 5100012345 blocked?', agent: 'fico', modelTier: 'standard' });
    expect(res.status).toBe(200);
    expect(provider.reported.cached).toBeGreaterThan(0);
    const totals = await stack.services.store.usage.totalsForUser(USERS.jordan, today());
    expect(totals.inputTokens).toBe(provider.reported.input);
    expect(totals.cachedInputTokens).toBe(provider.reported.cached);
    const audit = stack.auditBuffer.events.find((e) => e.type === 'MODEL_PROVIDER_USED');
    expect(audit?.details).toMatchObject({ inputTokens: provider.reported.input, cachedInputTokens: provider.reported.cached });
  });
});
