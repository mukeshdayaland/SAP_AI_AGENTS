import multipart from '@fastify/multipart';
import { M, createContext, enrichContext, runWithContext } from '@prowess/observability';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './api/routes.js';
import { AppError, toAppError, toPublicError } from './errors/app-error.js';
import type { Services } from './services.js';

const PUBLIC_PATHS = new Set(['/api/health', '/api/v1/health', '/api/readiness', '/api/v1/readiness', '/metrics']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * HTTP layer only: context propagation, authentication, CSRF defence,
 * security headers and error mapping. Business logic lives in services.
 */
export async function buildApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: true,
    requestIdHeader: false,
    return503OnClosing: true,
  });
  await app.register(multipart, { limits: { fileSize: s.config.uploads.maxBytes, files: 1 } });

  // Correlation / trace context for every request.
  app.addHook('onRequest', (req, _reply, done) => {
    const ctx = createContext({
      traceparent: req.headers.traceparent as string | undefined,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });
    (req as { startedAt?: number }).startedAt = Date.now();
    runWithContext(ctx, done);
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    const path = req.url.split('?')[0]!;
    if (PUBLIC_PATHS.has(path)) return;

    // CSRF: state-changing calls must carry a custom header, which browsers
    // cannot attach cross-site without a CORS preflight (which we never grant).
    if (MUTATING.has(req.method) && req.headers['x-requested-with'] !== 'prowess') {
      throw new AppError('CSRF_CHECK_FAILED', 'The request was rejected by CSRF protection.', 'AUTHORIZATION');
    }
    const origin = req.headers.origin;
    if (origin && s.config.cors.allowedOrigins.length && !s.config.cors.allowedOrigins.includes(origin)) {
      throw new AppError('ORIGIN_REJECTED', 'The request origin is not allowed.', 'AUTHORIZATION');
    }

    const auth = await s.authenticator.authenticate(req.headers);
    if (!auth) throw AppError.unauthenticated();
    if (!auth.user.roles.length) {
      s.audit.record({ type: 'SECURITY_DENIAL', userId: auth.user.id, tenantId: auth.user.tenantId, status: 'denied', details: { reason: 'no_roles', path } });
      throw AppError.forbidden('Your account has not been granted access to Prowess AI.');
    }
    req.auth = auth;
    enrichContext({ userId: auth.user.id, tenantId: auth.user.tenantId });
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const duration = Date.now() - ((req as { startedAt?: number }).startedAt ?? Date.now());
    M.httpRequests().inc({ route, method: req.method, status: String(reply.statusCode) });
    M.httpDuration().observe({ route, method: req.method }, duration);
    if (route !== '/api/health' && route !== '/metrics') {
      s.logger.info('http.request', { method: req.method, route, status: reply.statusCode, durationMs: duration });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const appError = toAppError(err);
    if (appError.category === 'INTERNAL') s.logger.error('http.unhandled', { error: (appError.internal ?? err) as Error });
    else if (appError.category === 'AUTHORIZATION') s.logger.warn('http.denied', { code: appError.code });
    const body = toPublicError(appError);
    if (appError.category === 'RATE_LIMIT') reply.header('retry-after', '10');
    return reply.code(appError.status).send({ error: body });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: toPublicError(AppError.notFound('Resource')) }));

  registerRoutes(app, s);
  return app;
}
