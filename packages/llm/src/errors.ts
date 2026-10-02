export type ProviderErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'auth'
  | 'bad_request'
  | 'content_filter'
  | 'circuit_open'
  | 'aborted'
  | 'configuration'
  | 'protocol';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limited', 'timeout', 'unavailable', 'circuit_open']);

/**
 * Normalized provider failure. `message` is operator-facing and must never
 * contain credentials or prompt content; upstream bodies are truncated.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}

export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}
