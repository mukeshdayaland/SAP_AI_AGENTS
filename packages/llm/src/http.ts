import { propagationHeaders } from '@prowess/observability';
import { ProviderError, kindFromStatus } from './errors.js';

export interface ResiliencePolicy {
  /** Time allowed to receive response headers. Streaming bodies are governed by `idleTimeoutMs`. */
  connectTimeoutMs: number;
  /** Max silence between streamed chunks before the stream is aborted. */
  idleTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_POLICY: ResiliencePolicy = {
  connectTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  maxRetries: 2,
  baseBackoffMs: 400,
  maxBackoffMs: 8_000,
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function backoffDelay(attempt: number, policy: ResiliencePolicy, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxBackoffMs * 4);
  const exp = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // equal jitter
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Circuit breaker: after `threshold` consecutive failures the circuit opens
 * for `cooldownMs`; one trial request is then allowed (half-open).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.threshold) return 'closed';
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  canPass(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.halfOpenInFlight) {
      this.halfOpenInFlight = true;
      return true;
    }
    return false;
  }

  success() {
    this.failures = 0;
    this.halfOpenInFlight = false;
  }

  failure() {
    this.halfOpenInFlight = false;
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

export interface ResilientFetchOptions {
  provider: string;
  url: string;
  init: RequestInit;
  policy: ResiliencePolicy;
  breaker?: CircuitBreaker;
  signal?: AbortSignal;
  /** Invoked before each attempt so short-lived auth headers can be refreshed. */
  headers?: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

/**
 * Performs an idempotent inference request with timeout, bounded retries,
 * exponential backoff honouring `Retry-After`, and circuit breaking.
 * Retries happen only before any response body has been consumed.
 */
export async function resilientFetch(opts: ResilientFetchOptions): Promise<Response> {
  const { provider, policy, breaker } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new ProviderError(provider, 'aborted', 'Request aborted');
    if (breaker && !breaker.canPass()) {
      throw new ProviderError(provider, 'circuit_open', 'Circuit open after repeated failures');
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('connect timeout')), policy.connectTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

    try {
      const auth = opts.headers ? await opts.headers() : {};
      const res = await doFetch(opts.url, {
        ...opts.init,
        headers: { ...(opts.init.headers as Record<string, string>), ...propagationHeaders(), ...auth },
        signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        breaker?.success();
        return res;
      }
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const kind = kindFromStatus(res.status);
      lastError = new ProviderError(
        provider,
        kind,
        `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
      if (lastError.retryable) breaker?.failure();
      if (!lastError.retryable) throw lastError;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError && !err.retryable) throw err;
      if (opts.signal?.aborted) throw new ProviderError(provider, 'aborted', 'Request aborted');
      if (!(err instanceof ProviderError)) {
        breaker?.failure();
        const timedOut = timeout.signal.aborted;
        lastError = new ProviderError(
          provider,
          timedOut ? 'timeout' : 'unavailable',
          timedOut ? `No response within ${policy.connectTimeoutMs} ms` : `Network error: ${(err as Error).message}`,
        );
      }
    }

    if (attempt < policy.maxRetries) {
      await sleep(backoffDelay(attempt, policy, lastError?.retryAfterMs), opts.signal);
    }
  }
  throw lastError ?? new ProviderError(provider, 'unavailable', 'Request failed');
}

/**
 * Wraps a response body so a stalled stream is aborted after `idleMs`
 * without data, and the caller's abort signal cancels the read.
 */
export async function* readBody(
  res: Response,
  provider: string,
  idleMs: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!res.body) throw new ProviderError(provider, 'protocol', 'Empty response body');
  const reader = res.body.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError(provider, 'aborted', 'Request aborted');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError(provider, 'timeout', `Stream idle for ${idleMs} ms`)), idleMs);
      });
      const result = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
