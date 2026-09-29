import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createServices } from './services.js';

const config = loadConfig();
const services = await createServices(config);
const app = await buildApp(services);
const { logger } = services;

logger.info('orchestrator.config', {
  env: config.environment,
  auth: config.auth.mode,
  persistence: config.persistence.mode,
  providers: services.providerNotes,
  preferredProvider: config.llm.preferredProvider ?? 'none',
  mcpServers: config.mcpServers.map((m) => m.id),
});

// Retention: conversations and expired uploads, hourly.
const retention = setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
    const conversations = await services.store.conversations.purgeUpdatedBefore(cutoff);
    const files = await services.files.purgeExpired();
    if (conversations || files) logger.info('retention.purged', { conversations, files });
  } catch (err) {
    logger.error('retention.failed', { error: err as Error });
  }
}, 3_600_000);
retention.unref();

await app.listen({ port: config.port, host: '0.0.0.0' });
logger.info('orchestrator.started', { port: config.port });

const shutdown = async (signal: string) => {
  logger.info('orchestrator.shutdown', { signal });
  clearInterval(retention);
  await app.close();
  await services.store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
