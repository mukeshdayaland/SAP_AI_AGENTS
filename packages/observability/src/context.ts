import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  requestId: string;
  /** W3C trace context, propagated to downstream services. */
  traceId: string;
  spanId: string;
  userId?: string;
  tenantId?: string;
  agent?: string;
  provider?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutates the active context (e.g. once the user or agent becomes known). */
export function enrichContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * Human-quotable support reference, e.g. `PRW-20260928-7A2F`.
 * The full correlation ID embeds it so logs can be searched either way.
 */
export function newCorrelationId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `PRW-${day}-${hex(2).toUpperCase()}-${hex(6)}`;
}

export function referenceFromCorrelationId(correlationId: string): string {
  const parts = correlationId.split('-');
  return parts.length >= 3 ? parts.slice(0, 3).join('-') : correlationId;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function createContext(input: { traceparent?: string | undefined; correlationId?: string | undefined }): RequestContext {
  const parsed = input.traceparent ? TRACEPARENT.exec(input.traceparent) : null;
  const correlationId =
    input.correlationId && /^[A-Za-z0-9-]{8,80}$/.test(input.correlationId) ? input.correlationId : newCorrelationId();
  return {
    correlationId,
    requestId: hex(8),
    traceId: parsed?.[1] ?? hex(16),
    spanId: hex(8),
  };
}

/** Headers to forward on outbound calls so traces and correlation survive hops. */
export function propagationHeaders(ctx = currentContext()): Record<string, string> {
  if (!ctx) return {};
  return {
    traceparent: `00-${ctx.traceId}-${hex(8)}-01`,
    'x-correlation-id': ctx.correlationId,
  };
}
