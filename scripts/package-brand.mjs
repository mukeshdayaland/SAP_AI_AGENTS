#!/usr/bin/env node
/**
 * Builds the web export for one brand (apps/web/src/lib/brand.ts) and
 * assembles apps/edge/dist from it:  node scripts/package-brand.mjs wtco
 * Every brand builds into the same directories, so package and deploy a
 * brand in one go — never deploy a dist left over from another brand.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = process.argv[2];
if (!brand) throw new Error('usage: node scripts/package-brand.mjs <brand>');

const run = (cmd, args) => {
  // On Windows npm is `npm.cmd`, which Node can only start through a shell.
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, NEXT_PUBLIC_BRAND: brand } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npm', ['run', 'build', '-w', '@prowess/web']);
run('node', ['scripts/package-cloudflare.mjs']);
