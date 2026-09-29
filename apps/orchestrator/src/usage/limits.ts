import { AppError } from '../errors/app-error.js';
import type { Store } from '../persistence/types.js';

/** Fixed-window-free token bucket per key (in-process; use a shared store when scaling out). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly burst = Math.max(3, Math.ceil(perMinute / 3)),
  ) {}

  take(key: string): void {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.updated) / 60_000) * this.perMinute);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      throw new AppError('RATE_LIMITED', 'You are sending requests too quickly. Please wait a moment.', 'RATE_LIMIT', true);
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
  }
}

/** Bulkhead: caps concurrent streams per user so one user cannot exhaust capacity. */
export class ConcurrencyGuard {
  private readonly active = new Map<string, number>();
  constructor(private readonly max: number) {}

  acquire(key: string): () => void {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) {
      throw new AppError('TOO_MANY_STREAMS', 'Please wait for your current response to finish.', 'RATE_LIMIT', true);
    }
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
}

export const today = () => new Date().toISOString().slice(0, 10);

export class QuotaService {
  constructor(
    private readonly store: Store,
    private readonly limits: { dailyTokensPerUser: number; dailyTokensPerAgent: number },
  ) {}

  async assertWithinQuota(userId: string, agent: string): Promise<void> {
    const day = today();
    const [user, agentTotals] = await Promise.all([this.store.usage.totalsForUser(userId, day), this.store.usage.totalsForAgent(agent, day)]);
    if (user.inputTokens + user.outputTokens >= this.limits.dailyTokensPerUser) {
      throw new AppError('USER_QUOTA_EXCEEDED', 'You have reached your daily AI usage limit. It resets at midnight UTC.', 'QUOTA');
    }
    if (agentTotals.inputTokens + agentTotals.outputTokens >= this.limits.dailyTokensPerAgent) {
      throw new AppError('AGENT_QUOTA_EXCEEDED', 'This agent has reached its daily usage limit. Please try again tomorrow.', 'QUOTA');
    }
  }
}
