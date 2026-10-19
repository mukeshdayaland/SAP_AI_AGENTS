import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';
const orchestrator = process.env.ORCHESTRATOR_URL ?? 'http://localhost:4000';
const fiori = process.env.FIORI_DEV_ORIGIN ?? 'http://localhost:4100';

/**
 * Production: static export served by the SAP approuter (prowess-ai-web),
 * which handles XSUAA login and forwards /api/* to the orchestrator with the
 * user's token. Development: Next dev server proxies /api/* to the local
 * orchestrator. The browser never talks to SAP, MCP or model providers.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  transpilePackages: ['@prowess/contracts'],
  // Compression would buffer Server-Sent Events in the dev proxy.
  compress: false,
  ...(isProd
    ? { output: 'export', trailingSlash: true, images: { unoptimized: true } }
    : {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${orchestrator}/api/:path*` },
            // Fiori on the workspace's own address, as the approuter serves it in production. Locally: the mock page of sap-mcp.
            { source: '/sap/:path*', destination: `${fiori}/sap/:path*` },
          ];
        },
      }),
};

export default config;
