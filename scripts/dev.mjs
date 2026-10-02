#!/usr/bin/env node
/**
 * Starts the full local stack with mocked SAP and (unless configured) the
 * offline mock model:
 *   sap-mcp :4100 → orchestrator :4000 → web :3000
 * Real provider credentials can be placed in `.env` (see .env.example).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const shared = {
  PROWESS_ENV: process.env.PROWESS_ENV ?? 'DEV',
  // Ephemeral per run unless provided — never commit a real value.
  SERVICE_ASSERTION_SECRET: process.env.SERVICE_ASSERTION_SECRET ?? randomBytes(32).toString('hex'),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

const apps = [
  { name: 'sap-mcp', color: 35, cmd: ['run', 'dev', '-w', '@prowess/sap-mcp'], env: { PORT: '4100', SAP_MODE: process.env.SAP_MODE ?? 'mock' } },
  { name: 'orchestrator', color: 36, cmd: ['run', 'dev', '-w', '@prowess/orchestrator'], env: { PORT: '4000', AUTH_MODE: 'dev', SAP_MCP_URL: 'http://localhost:4100/mcp' } },
  { name: 'web', color: 33, cmd: ['run', 'dev', '-w', '@prowess/web'], env: { ORCHESTRATOR_URL: 'http://localhost:4000' } },
];

// On Windows npm is `npm.cmd`, which Node can only start through a shell.
const isWindows = process.platform === 'win32';

const children = apps.map(({ name, color, cmd, env }) => {
  const prefix = `\x1b[${color}m${name.padEnd(12)}\x1b[0m│ `;
  const child = spawn('npm', cmd, { env: { ...process.env, ...shared, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows });
  child.on('error', (err) => {
    process.stdout.write(`${prefix}failed to start: ${err.message}\n`);
    shutdown(1);
  });
  const pipe = (stream) =>
    stream.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
  return child;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // With a shell on Windows, kill() stops only cmd.exe; end the whole process tree instead.
    if (isWindows) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write('\n  Prowess AI → http://localhost:3000\n\n');
