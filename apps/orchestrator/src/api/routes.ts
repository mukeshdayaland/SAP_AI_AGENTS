import {
  ChatRequestSchema,
  ConfirmActionSchema,
  FeedbackRequestSchema,
  RenameConversationSchema,
  StartRunSchema,
  type HelpOverview,
  type WorkspaceConfig,
} from '@prowess/contracts';
import { metrics } from '@prowess/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext } from '../auth/types.js';
import { hasAnyRole, hasRole } from '../auth/types.js';
import { AppError } from '../errors/app-error.js';
import { toMessageDTO } from '../conversations/mappers.js';
import { SSEStream } from '../streaming/sse.js';
import type { Services } from '../services.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const IdParam = z.object({ id: z.string().regex(/^[a-z]_[A-Za-z0-9_-]{16,40}$/) });
const WorkflowParam = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) });
const MessageParams = IdParam.extend({ messageId: z.string().regex(/^m_[A-Za-z0-9_-]{16,40}$/) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.validation(r.error.issues[0]?.message ?? 'The request is invalid.');
  return r.data;
}

function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

const USER_ACTIVITY: ReadonlySet<string> = new Set([
  'SAP_READ',
  'SAP_WRITE_REQUESTED',
  'SAP_WRITE_CONFIRMED',
  'SAP_WRITE_CANCELLED',
  'SAP_WRITE_COMPLETED',
  'SAP_WRITE_FAILED',
  'WORKFLOW_STARTED',
  'WORKFLOW_ENDED',
]);

const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim();

export function registerRoutes(app: FastifyInstance, s: Services): void {
  /* ---------------- health (unauthenticated, no data) ---------------- */
  const health = async () => ({ status: 'ok' });
  const readiness = async (_req: FastifyRequest, reply: FastifyReply) => {
    const [store, mcp, providers] = await Promise.all([s.store.healthCheck(), s.mcp.health(), s.router.health()]);
    const ready = store && Object.values(providers).some(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: { store, mcp, providers } });
  };
  app.get('/api/health', health);
  app.get('/api/v1/health', health);
  app.get('/api/readiness', readiness);
  app.get('/api/v1/readiness', readiness);
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(metrics.render()));

  /* ---------------- workspace ---------------- */
  app.get('/api/v1/workspace', async (req): Promise<WorkspaceConfig> => {
    const { user } = auth(req);
    s.audit.record({ type: 'USER_LOGIN', userId: user.id, tenantId: user.tenantId, status: 'success', details: { authMode: s.config.auth.mode } });
    const agents = s.agents.describeAgents(user);
    const agentIds = new Set(agents.map((a) => a.id));
    const defaultAgent = agentIds.has(s.agents.defaultAgentId) ? s.agents.defaultAgentId : (agents[0]?.id ?? s.agents.defaultAgentId);
    const tiers = s.agents.describeTiers(user);
    return {
      product: { name: 'Prowess AI', subtitle: 'Enterprise Intelligence Workspace' },
      environment: s.config.environment,
      user,
      agents,
      modelTiers: tiers,
      defaultAgent,
      defaultModelTier: tiers[0]?.id ?? 'standard',
      starters: s.agents.starters.filter((st) => agentIds.has(st.agent)),
      features: {
        attachments: s.config.uploads.enabled,
        feedback: true,
        technicalPanel: hasAnyRole(user, ['AI_POWER_USER', 'AI_ADMIN']),
        admin: hasRole(user, 'AI_ADMIN'),
        audit: hasAnyRole(user, ['AI_AUDITOR', 'AI_ADMIN']),
      },
      uploads: { maxBytes: s.config.uploads.maxBytes, accept: s.config.uploads.allowedTypes.map((t) => `.${t}`) },
    };
  });
  app.get('/api/v1/agents', async (req) => s.agents.describeAgents(auth(req).user));
  app.get('/api/v1/models', async (req) => s.agents.describeTiers(auth(req).user));

  /* ---------------- chat (SSE) ---------------- */
  app.post('/api/v1/chat', async (req, reply) => {
    const a = auth(req);
    const body = parse(ChatRequestSchema, req.body);
    s.rateLimiter.take(a.user.id);
    const release = s.streams.acquire(a.user.id);
    try {
      const turn = await s.chat.prepare(a, body);
      reply.hijack();
      const sse = new SSEStream(reply.raw, { 'x-correlation-id': turn.correlationId });
      try {
        await s.chat.execute(turn, (e) => sse.send(e), sse.signal);
      } finally {
        sse.end();
      }
    } finally {
      release();
    }
  });

  /* ---------------- conversations ---------------- */
  app.get('/api/v1/conversations', async (req) => s.conversations.list(auth(req)));
  app.get('/api/v1/conversations/:id', async (req) => s.conversations.get(auth(req), parse(IdParam, req.params).id));
  app.patch('/api/v1/conversations/:id', async (req) => {
    const { title } = parse(RenameConversationSchema, req.body);
    return s.conversations.rename(auth(req), parse(IdParam, req.params).id, title);
  });
  app.delete('/api/v1/conversations/:id', async (req, reply) => {
    await s.conversations.delete(auth(req), parse(IdParam, req.params).id);
    return reply.code(204).send();
  });
  app.post('/api/v1/conversations/:id/messages/:messageId/feedback', async (req, reply) => {
    const { id, messageId } = parse(MessageParams, req.params);
    const { rating, comment } = parse(FeedbackRequestSchema, req.body);
    await s.conversations.feedback(auth(req), id, messageId, rating, comment);
    return reply.code(204).send();
  });

  /* ---------------- confirmations ---------------- */
  app.post('/api/v1/actions/:id/confirm', async (req) => {
    const body = parse(ConfirmActionSchema, req.body ?? {});
    return s.actions.confirm(auth(req), parse(IdParam, req.params).id, body.acknowledgeEnvironment);
  });
  app.post('/api/v1/actions/:id/cancel', async (req) => s.actions.cancel(auth(req), parse(IdParam, req.params).id));

  /* ---------------- workflow runs ---------------- */
  app.get('/api/v1/workflows', async (req) => s.workflows.describe(auth(req).user));
  app.post('/api/v1/workflows/:id/runs', async (req, reply) => {
    const a = auth(req);
    const { id } = parse(WorkflowParam, req.params);
    const { input } = parse(StartRunSchema, req.body);
    s.rateLimiter.take(a.user.id);
    const { run, message } = await s.workflows.startStandalone(a, id, input, req.id);
    return reply.code(201).send({ run: s.workflows.toDTO(run), conversationId: run.conversationId, message: toMessageDTO(message, a.user) });
  });
  app.get('/api/v1/runs/:id', async (req) => s.workflows.get(auth(req), parse(IdParam, req.params).id));

  /* ---------------- files ---------------- */
  app.post('/api/v1/files', async (req, reply) => {
    const a = auth(req);
    s.rateLimiter.take(a.user.id);
    const file = await req.file({ limits: { fileSize: s.config.uploads.maxBytes, files: 1, fields: 0 } });
    if (!file) throw AppError.validation('No file was provided.');
    const data = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('PAYLOAD_TOO_LARGE', 'The file is too large.', 'VALIDATION');
      throw err;
    });
    return reply.code(201).send(await s.files.upload(a, file.filename, data));
  });
  app.delete('/api/v1/files/:id', async (req, reply) => {
    await s.files.delete(auth(req), parse(IdParam, req.params).id);
    return reply.code(204).send();
  });

  /* ---------------- help: what the user's agents can do, and the user's own activity ---------------- */
  app.get('/api/v1/help', async (req): Promise<HelpOverview> => {
    const { user } = auth(req);
    const tools = await s.mcp.listTools(s.config.environment).catch(() => []);
    const titles = new Map(tools.map((t) => [t.name, t.title]));
    const names = new Map(s.agents.all().map((a) => [a.id, a.name]));
    return {
      agents: s.agents.forUser(user).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        icon: a.icon,
        capabilities: s.agents.toolsFor(a, tools).map((t) => {
          const risk = s.policy.effectiveRisk(t.name, t.risk);
          return { title: t.title, description: firstSentence(t.description), risk, needsConfirmation: risk !== 'READ' };
        }),
      })),
      // Only the caller's own events: the full trail stays with auditors and administrators.
      activity: s.auditBuffer.events
        .filter((e) => e.userId === user.id && e.tenantId === user.tenantId && USER_ACTIVITY.has(e.type))
        .slice(0, 100)
        .map((e) => {
          const object = [e.details?.objectType, e.details?.objectId].filter(Boolean).join(' ');
          const action = e.tool ? (titles.get(e.tool) ?? e.tool) : e.details?.workflow ? String(e.details.workflow) : undefined;
          return {
            id: e.id,
            timestamp: e.timestamp,
            type: e.type,
            status: e.status,
            ...(e.agent && { agent: names.get(e.agent) ?? e.agent }),
            ...(action && { action }),
            ...(object && { object }),
            ...(e.targetSystem && { system: e.targetSystem }),
          };
        }),
    };
  });

  /* ---------------- administration ---------------- */
  app.get('/api/v1/admin/overview', async (req) => {
    const a = auth(req);
    if (!hasRole(a.user, 'AI_ADMIN')) throw AppError.forbidden();
    s.audit.record({ type: 'ADMIN_ACCESS', userId: a.user.id, tenantId: a.user.tenantId, status: 'success', details: { view: 'overview' } });
    const [providers, mcp, tools, usage] = await Promise.all([
      s.router.health(),
      s.mcp.health(),
      s.mcp.listTools(s.config.environment).catch(() => []),
      s.store.usage.summary(new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)),
    ]);
    return {
      environment: s.config.environment,
      providers: Object.entries(providers).map(([id, healthy]) => ({ id, healthy, note: s.providerNotes.find((n) => n.startsWith(id)) ?? '' })),
      preferredProvider: s.config.llm.preferredProvider ?? null,
      modelTiers: s.router.tiers.map((t) => ({ ...t, resolved: s.router.resolveTargets(t.id) })),
      agents: s.agents.all().map(({ instructions: _i, ...rest }) => rest),
      tools: tools.filter((t) => !t.internal).map((t) => ({ name: t.name, title: t.title, risk: s.policy.effectiveRisk(t.name, t.risk), domain: t.domain, server: t.serverId, system: t.targetSystem })),
      mcpServers: s.config.mcpServers.map((m) => ({ id: m.id, healthy: mcp[m.id] ?? false })),
      usage,
      settings: {
        retentionDays: s.config.retentionDays,
        uploads: { enabled: s.config.uploads.enabled, maxBytes: s.config.uploads.maxBytes, allowedTypes: s.config.uploads.allowedTypes, scanner: s.config.uploads.scanner },
        limits: s.config.limits,
        confirmationTtlSeconds: s.config.confirmations.ttlSeconds,
        persistence: s.config.persistence.mode,
        authMode: s.config.auth.mode,
      },
    };
  });

  app.get('/api/v1/admin/audit', async (req) => {
    const a = auth(req);
    if (!hasAnyRole(a.user, ['AI_AUDITOR', 'AI_ADMIN'])) throw AppError.forbidden();
    s.audit.record({ type: 'ADMIN_ACCESS', userId: a.user.id, tenantId: a.user.tenantId, status: 'success', details: { view: 'audit' } });
    return { events: s.auditBuffer.events.slice(0, 200) };
  });
}
