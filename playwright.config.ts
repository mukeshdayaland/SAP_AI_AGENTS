import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the full local stack (web → orchestrator → SAP MCP)
 * with the mock model and mock S/4HANA — no credentials, no live LLM calls.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.PW_CHROMIUM_PATH && { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }),
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://localhost:3000',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { LOG_LEVEL: 'warn' },
  },
});
