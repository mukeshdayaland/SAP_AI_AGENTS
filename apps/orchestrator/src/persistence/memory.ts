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

const owns = (o: Owner, r: Owner) => o.userId === r.userId && o.tenantId === r.tenantId;
const clone = <T>(v: T): T => structuredClone(v);

/** Process-local store for development and tests. Not for production (single instance, volatile). */
export class MemoryStore implements Store {
  private readonly convs = new Map<string, ConversationRecord>();
  private readonly msgs = new Map<string, MessageRecord[]>();
  private readonly atts = new Map<string, AttachmentRecord>();
  private readonly acts = new Map<string, PendingActionRecord>();
  private readonly runRows = new Map<string, WorkflowRunRecord>();
  private readonly usageRows: UsageRecord[] = [];

  conversations = {
    create: async (c: ConversationRecord) => {
      this.convs.set(c.id, clone(c));
      this.msgs.set(c.id, []);
    },
    get: async (o: Owner, id: string) => {
      const c = this.convs.get(id);
      return c && owns(o, c) ? clone(c) : null;
    },
    list: async (o: Owner, limit: number) =>
      [...this.convs.values()]
        .filter((c) => owns(o, c))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map(clone),
    update: async (o: Owner, id: string, patch: Partial<ConversationRecord>) => {
      const c = this.convs.get(id);
      if (!c || !owns(o, c)) return false;
      Object.assign(c, patch);
      return true;
    },
    delete: async (o: Owner, id: string) => {
      const c = this.convs.get(id);
      if (!c || !owns(o, c)) return false;
      this.convs.delete(id);
      this.msgs.delete(id);
      return true;
    },
    purgeUpdatedBefore: async (cutoff: string) => {
      let n = 0;
      for (const [id, c] of this.convs) {
        if (c.updatedAt < cutoff) {
          this.convs.delete(id);
          this.msgs.delete(id);
          n++;
        }
      }
      return n;
    },
  };

  messages = {
    add: async (m: MessageRecord) => {
      const list = this.msgs.get(m.conversationId);
      if (!list) throw new Error('Conversation does not exist');
      list.push(clone(m));
    },
    list: async (conversationId: string) => clone(this.msgs.get(conversationId) ?? []),
    update: async (conversationId: string, id: string, patch: Partial<MessageRecord>) => {
      const m = this.msgs.get(conversationId)?.find((x) => x.id === id);
      if (!m) return false;
      Object.assign(m, clone(patch));
      return true;
    },
    deleteFrom: async (conversationId: string, createdAt: string) => {
      const list = this.msgs.get(conversationId) ?? [];
      const keep = list.filter((m) => m.createdAt < createdAt);
      this.msgs.set(conversationId, keep);
      return list.length - keep.length;
    },
  };

  attachments = {
    create: async (a: AttachmentRecord) => void this.atts.set(a.id, clone(a)),
    get: async (o: Owner, id: string) => {
      const a = this.atts.get(id);
      return a && owns(o, a) ? clone(a) : null;
    },
    delete: async (o: Owner, id: string) => {
      const a = this.atts.get(id);
      if (!a || !owns(o, a)) return false;
      return this.atts.delete(id);
    },
    listExpired: async (now: string) => [...this.atts.values()].filter((a) => a.expiresAt < now).map(clone),
    deleteById: async (id: string) => void this.atts.delete(id),
  };

  actions = {
    create: async (a: PendingActionRecord) => void this.acts.set(a.id, clone(a)),
    get: async (o: Owner, id: string) => {
      const a = this.acts.get(id);
      return a && owns(o, a) ? clone(a) : null;
    },
    transition: async (o: Owner, id: string, from: PendingActionRecord['status'], to: PendingActionRecord['status'], patch: Partial<PendingActionRecord> = {}) => {
      const a = this.acts.get(id);
      if (!a || !owns(o, a) || a.status !== from) return false;
      Object.assign(a, patch, { status: to });
      return true;
    },
  };

  runs = {
    create: async (r: WorkflowRunRecord) => void this.runRows.set(r.id, clone(r)),
    get: async (o: Owner, id: string) => {
      const r = this.runRows.get(id);
      return r && owns(o, r) ? clone(r) : null;
    },
    update: async (o: Owner, r: WorkflowRunRecord) => {
      const current = this.runRows.get(r.id);
      if (!current || !owns(o, current)) return false;
      this.runRows.set(r.id, clone(r));
      return true;
    },
  };

  usage = {
    record: async (u: UsageRecord) => void this.usageRows.push(clone(u)),
    totalsForUser: async (userId: string, day: string) => this.totals((u) => u.userId === userId && u.day === day),
    totalsForAgent: async (agent: string, day: string) => this.totals((u) => u.agent === agent && u.day === day),
    summary: async (sinceDay: string) => {
      const groups = new Map<string, { day: string; provider: string; modelTier: string; agent: string; inputTokens: number; outputTokens: number; requests: number }>();
      for (const u of this.usageRows.filter((r) => r.day >= sinceDay)) {
        const key = `${u.day}|${u.provider}|${u.modelTier}|${u.agent}`;
        const g = groups.get(key) ?? { day: u.day, provider: u.provider, modelTier: u.modelTier, agent: u.agent, inputTokens: 0, outputTokens: 0, requests: 0 };
        g.inputTokens += u.inputTokens;
        g.outputTokens += u.outputTokens;
        g.requests += 1;
        groups.set(key, g);
      }
      return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day));
    },
  };

  private totals(pred: (u: UsageRecord) => boolean): UsageTotals {
    return this.usageRows.filter(pred).reduce((t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens, requests: t.requests + 1 }), {
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
  }

  async healthCheck() {
    return true;
  }

  async close() {}
}
