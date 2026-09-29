import { createLogger } from '@prowess/observability';
import { createMcpHttpServer } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const logger = createLogger({ service: 'prowess-sap-mcp', level: cfg.logLevel });
const server = createMcpHttpServer(cfg, { logger });

server.listen(cfg.port, () => {
  logger.info('mcp.started', { port: cfg.port, sapMode: cfg.sap.mode, system: cfg.sap.systemId, domains: [...cfg.domains], env: cfg.environment });
});

const shutdown = (signal: string) => {
  logger.info('mcp.shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
