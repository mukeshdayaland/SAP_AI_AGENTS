import pg from 'pg';
import type {
  AttachmentRecord,
  ConversationRecord,
  MessageRecord,
  Owner,
  PendingActionRecord,
  Store,
  UsageRecord,
  UsageTotals,
  WorkflowRunRecord,
} from './types.js';

/**
 * PostgreSQL store (SAP BTP PostgreSQL, hyperscaler option). All user-owned
 * queries include `user_id` and `tenant_id` predicates. Only parameterized
 * statements are used. A HANA Cloud implementation would implement the same
 * `Store` port (see docs/architecture.md).
 */

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  summary TEXT,
  summary_until TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_owner_idx ON conversations (tenant_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  extracted_text TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_expiry_idx ON attachments (expires_at);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  day DATE NOT NULL,
  at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_day_idx ON usage_events (user_id, day);
CREATE INDEX IF NOT EXISTS usage_agent_day_idx ON usage_events (agent, day);
`,
  },
  {
    id: 2,
    sql: `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_runs_owner_idx ON workflow_runs (tenant_id, user_id, updated_at DESC);
`,
  },
];

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

type Row = Record<string, unknown>;

function toConversation(r: Row): ConversationRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tenantId: String(r.tenant_id),
    title: String(r.title),
    agent: String(r.agent),
    modelTier: String(r.model_tier),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.summary ? { summary: String(r.summary) } : {}),
    ...(r.summary_until ? { summaryUntil: String(r.summary_until) } : {}),
  };
}

function toMessage(r: Row): MessageRecord {
  return {
    ...(r.data as Partial<MessageRecord>),
    id: String(r.id),
    conversationId: String(r.conversation_id),
    role: r.role as MessageRecord['role'],
    content: String(r.content),
    status: r.status as MessageRecord['status'],
    createdAt: iso(r.created_at),
  };
}

function messageData(m: Partial<MessageRecord>): Partial<MessageRecord> {
  const { id: _id, conversationId: _c, role: _r, content: _ct, status: _s, createdAt: _d, ...rest } = m;
  return rest;
}

function toAttachment(r: Row): AttachmentRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tenantId: String(r.tenant_id),
    fileName: String(r.file_name),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes),
    storageKey: String(r.storage_key),
    ...(r.extracted_text ? { extractedText: String(r.extracted_text) } : {}),
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      ssl: /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: !/sslmode=no-verify/.test(connectionString) },
    });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727001)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const { rows } = await client.query('SELECT id FROM schema_migrations');
      const applied = new Set(rows.map((r: Row) => Number(r.id)));
      for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
      client.release();
    }
  }

  private q(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params);
  }

  conversations = {
    create: async (c: ConversationRecord) => {
      await this.q(
        'INSERT INTO conversations (id,user_id,tenant_id,title,agent,model_tier,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [c.id, c.userId, c.tenantId, c.title, c.agent, c.modelTier, c.createdAt, c.updatedAt],
      );
    },
    get: async (o: Owner, id: string) => {
      const { rows } = await this.q('SELECT * FROM conversations WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId]);
      return rows[0] ? toConversation(rows[0]) : null;
    },
    list: async (o: Owner, limit: number) => {
      const { rows } = await this.q('SELECT * FROM conversations WHERE user_id=$1 AND tenant_id=$2 ORDER BY updated_at DESC LIMIT $3', [o.userId, o.tenantId, limit]);
      return rows.map(toConversation);
    },
    update: async (o: Owner, id: string, patch: Partial<ConversationRecord>) => {
      const cols: Record<string, string> = { title: 'title', agent: 'agent', modelTier: 'model_tier', updatedAt: 'updated_at', summary: 'summary', summaryUntil: 'summary_until' };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, col] of Object.entries(cols)) {
        if (k in patch) {
          params.push((patch as Record<string, unknown>)[k] ?? null);
          sets.push(`${col}=$${params.length}`);
        }
      }
      if (!sets.length) return true;
      params.push(id, o.userId, o.tenantId);
      const res = await this.q(`UPDATE conversations SET ${sets.join(',')} WHERE id=$${params.length - 2} AND user_id=$${params.length - 1} AND tenant_id=$${params.length}`, params);
      return (res.rowCount ?? 0) > 0;
    },
    delete: async (o: Owner, id: string) => {
      const res = await this.q('DELETE FROM conversations WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId]);
      return (res.rowCount ?? 0) > 0;
    },
    purgeUpdatedBefore: async (cutoff: string) => (await this.q('DELETE FROM conversations WHERE updated_at < $1', [cutoff])).rowCount ?? 0,
  };

  messages = {
    add: async (m: MessageRecord) => {
      await this.q('INSERT INTO messages (id,conversation_id,role,content,status,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        m.id,
        m.conversationId,
        m.role,
        m.content,
        m.status,
        m.createdAt,
        JSON.stringify(messageData(m)),
      ]);
    },
    list: async (conversationId: string) => {
      const { rows } = await this.q('SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at, id', [conversationId]);
      return rows.map(toMessage);
    },
    update: async (conversationId: string, id: string, patch: Partial<MessageRecord>) => {
      const res = await this.q(
        `UPDATE messages SET content=COALESCE($3,content), status=COALESCE($4,status), data = data || $5::jsonb WHERE conversation_id=$1 AND id=$2`,
        [conversationId, id, patch.content ?? null, patch.status ?? null, JSON.stringify(messageData(patch))],
      );
      return (res.rowCount ?? 0) > 0;
    },
    deleteFrom: async (conversationId: string, createdAt: string) =>
      (await this.q('DELETE FROM messages WHERE conversation_id=$1 AND created_at >= $2', [conversationId, createdAt])).rowCount ?? 0,
  };

  attachments = {
    create: async (a: AttachmentRecord) => {
      await this.q(
        'INSERT INTO attachments (id,user_id,tenant_id,file_name,mime_type,size_bytes,storage_key,extracted_text,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [a.id, a.userId, a.tenantId, a.fileName, a.mimeType, a.sizeBytes, a.storageKey, a.extractedText ?? null, a.createdAt, a.expiresAt],
      );
    },
    get: async (o: Owner, id: string) => {
      const { rows } = await this.q('SELECT * FROM attachments WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId]);
      return rows[0] ? toAttachment(rows[0]) : null;
    },
    delete: async (o: Owner, id: string) => ((await this.q('DELETE FROM attachments WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId])).rowCount ?? 0) > 0,
    listExpired: async (now: string) => (await this.q('SELECT * FROM attachments WHERE expires_at < $1 LIMIT 500', [now])).rows.map(toAttachment),
    deleteById: async (id: string) => void (await this.q('DELETE FROM attachments WHERE id=$1', [id])),
  };

  actions = {
    create: async (a: PendingActionRecord) => {
      await this.q('INSERT INTO pending_actions (id,user_id,tenant_id,status,created_at,expires_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        a.id,
        a.userId,
        a.tenantId,
        a.status,
        a.createdAt,
        a.expiresAt,
        JSON.stringify(a),
      ]);
    },
    get: async (o: Owner, id: string) => {
      const { rows } = await this.q('SELECT data, status FROM pending_actions WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId]);
      return rows[0] ? ({ ...(rows[0].data as PendingActionRecord), status: rows[0].status } as PendingActionRecord) : null;
    },
    transition: async (o: Owner, id: string, from: string, to: string, patch: Partial<PendingActionRecord> = {}) => {
      const res = await this.q(
        `UPDATE pending_actions SET status=$5, data = data || $6::jsonb WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND status=$4`,
        [id, o.userId, o.tenantId, from, to, JSON.stringify({ ...patch, status: to })],
      );
      return (res.rowCount ?? 0) > 0;
    },
  };

  runs = {
    create: async (r: WorkflowRunRecord) => {
      await this.q('INSERT INTO workflow_runs (id,user_id,tenant_id,workflow,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        r.id,
        r.userId,
        r.tenantId,
        r.workflow,
        r.status,
        r.createdAt,
        r.updatedAt,
        JSON.stringify(r),
      ]);
    },
    get: async (o: Owner, id: string) => {
      const { rows } = await this.q('SELECT data FROM workflow_runs WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, o.userId, o.tenantId]);
      return rows[0] ? (rows[0].data as WorkflowRunRecord) : null;
    },
    update: async (o: Owner, r: WorkflowRunRecord) => {
      const res = await this.q('UPDATE workflow_runs SET status=$4, updated_at=$5, data=$6 WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [
        r.id,
        o.userId,
        o.tenantId,
        r.status,
        r.updatedAt,
        JSON.stringify(r),
      ]);
      return (res.rowCount ?? 0) > 0;
    },
  };

  usage = {
    record: async (u: UsageRecord) => {
      await this.q(
        'INSERT INTO usage_events (user_id,tenant_id,agent,provider,model,model_tier,input_tokens,output_tokens,duration_ms,day,at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [u.userId, u.tenantId, u.agent, u.provider, u.model, u.modelTier, u.inputTokens, u.outputTokens, u.durationMs, u.day, u.at],
      );
    },
    totalsForUser: (userId: string, day: string) => this.totals('user_id', userId, day),
    totalsForAgent: (agent: string, day: string) => this.totals('agent', agent, day),
    summary: async (sinceDay: string) => {
      const { rows } = await this.q(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, provider, model_tier, agent, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens, COUNT(*)::int AS requests
         FROM usage_events WHERE day >= $1 GROUP BY 1,2,3,4 ORDER BY 1 DESC`,
        [sinceDay],
      );
      return rows.map((r: Row) => ({
        day: String(r.day),
        provider: String(r.provider),
        modelTier: String(r.model_tier),
        agent: String(r.agent),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        requests: Number(r.requests),
      }));
    },
  };

  private async totals(col: 'user_id' | 'agent', value: string, day: string): Promise<UsageTotals> {
    const { rows } = await this.q(
      `SELECT COALESCE(SUM(input_tokens),0)::int AS i, COALESCE(SUM(output_tokens),0)::int AS o, COUNT(*)::int AS n FROM usage_events WHERE ${col}=$1 AND day=$2`,
      [value, day],
    );
    return { inputTokens: Number(rows[0]?.i ?? 0), outputTokens: Number(rows[0]?.o ?? 0), requests: Number(rows[0]?.n ?? 0) };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.q('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
