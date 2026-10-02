import { randomUUID } from 'node:crypto';
import { currentContext, type Logger } from '@prowess/observability';

/**
 * Business audit trail — deliberately separate from technical logs.
 * Events carry identifiers and outcomes only: never tokens, secrets,
 * prompts, model output or business payloads.
 */

export const AUDIT_EVENTS = [
  'USER_LOGIN',
  'CONVERSATION_CREATED',
  'CONVERSATION_DELETED',
  'AGENT_INVOKED',
  'MCP_TOOL_INVOKED',
  'SAP_READ',
  'SAP_WRITE_REQUESTED',
  'SAP_WRITE_CONFIRMED',
  'SAP_WRITE_CANCELLED',
  'SAP_WRITE_COMPLETED',
  'SAP_WRITE_FAILED',
  'WORKFLOW_STARTED',
  'WORKFLOW_ENDED',
  'MODEL_PROVIDER_USED',
  'FILE_UPLOADED',
  'SECURITY_DENIAL',
  'ADMIN_ACCESS',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  timestamp: string;
  correlationId: string;
  userId: string;
  tenantId: string;
  agent?: string;
  tool?: string;
  targetSystem?: string;
  operation?: string;
  status: 'success' | 'failure' | 'denied' | 'pending';
  durationMs?: number;
  /** Identifiers only (object IDs, provider names). */
  details?: Record<string, string | number | boolean>;
}

export type AuditInput = Omit<AuditEvent, 'id' | 'timestamp' | 'correlationId'> & { correlationId?: string };

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

/** JSON lines on stdout tagged `audit` — routed separately by SAP Cloud Logging. */
export class StdoutAuditSink implements AuditSink {
  async write(event: AuditEvent) {
    process.stdout.write(`${JSON.stringify({ kind: 'audit', ...event })}\n`);
  }
}

/**
 * SAP Audit Log service (v2 OAuth plan). Maps Prowess events to the service's
 * categories: SAP reads → data-accesses, SAP writes → data-modifications,
 * everything else → security-events.
 */
export class BtpAuditLogSink implements AuditSink {
  private token?: { value: string; exp: number };

  constructor(
    private readonly cfg: { url: string; tokenUrl: string; clientId: string; clientSecret: string },
    private readonly logger: Logger,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Audit log token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, exp: Date.now() + body.expires_in * 1_000 };
    return this.token.value;
  }

  async write(event: AuditEvent) {
    const base = this.cfg.url.replace(/\/+$/, '');
    const isRead = event.type === 'SAP_READ';
    const isWrite = event.type.startsWith('SAP_WRITE');
    const path = isRead ? 'data-accesses' : isWrite ? 'data-modifications' : 'security-events';
    const common = { uuid: event.id, user: event.userId, tenant: event.tenantId, time: event.timestamp };
    const body = isRead
      ? { ...common, object: { type: event.details?.objectType ?? 'SAP', id: { key: String(event.details?.objectId ?? event.tool ?? '') } }, attributes: [{ name: event.tool ?? 'n/a' }], data_subject: { type: 'none', id: { key: 'n/a' } } }
      : isWrite
        ? { ...common, object: { type: event.details?.objectType ?? 'SAP', id: { key: String(event.details?.objectId ?? '') } }, attributes: [{ name: event.tool ?? 'n/a', new: event.status }], data_subject: { type: 'none', id: { key: 'n/a' } }, success: event.status === 'success' }
        : { ...common, data: JSON.stringify({ type: event.type, status: event.status, correlationId: event.correlationId, ...event.details }) };
    try {
      const res = await fetch(`${base}/audit-log/oauth2/api/v2/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.accessToken()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Never lose an audit record silently: fall back to stdout and alert via logs.
      this.logger.error('audit.sink_failed', { error: (err as Error).message, eventType: event.type });
      await new StdoutAuditSink().write(event);
    }
  }
}

/** Keeps the latest events in memory for the auditor view in development. */
export class RingBufferAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  constructor(private readonly capacity = 1_000) {}
  async write(event: AuditEvent) {
    this.events.unshift(event);
    if (this.events.length > this.capacity) this.events.length = this.capacity;
  }
}

export class AuditTrail {
  constructor(private readonly sinks: AuditSink[]) {}

  record(input: AuditInput): void {
    const ctx = currentContext();
    const event: AuditEvent = {
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: input.correlationId ?? ctx?.correlationId ?? 'n/a',
    };
    for (const sink of this.sinks) void sink.write(event);
  }
}
