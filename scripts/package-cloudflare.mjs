#!/usr/bin/env node
/**
 * Assembles apps/edge/dist for Cloudflare Pages: the static Next.js export
 * plus the signed-out page. Security headers and the CSP script hashes are
 * set at request time by the BFF (apps/edge/src/bff.ts), because Pages'
 * `_headers` file does not apply to responses that pass through Functions.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Optional argument: an `out` directory built elsewhere (e.g. a clean worktree of a release commit).
const out = process.argv[2] ? resolve(process.argv[2]) : join(root, 'apps/web/out');
const dist = join(root, 'apps/edge/dist');

if (!existsSync(out)) throw new Error('apps/web/out not found — run `npm run build -w @prowess/web` first');
rmSync(dist, { recursive: true, force: true });
cpSync(out, dist, { recursive: true });
cpSync(join(root, 'infrastructure/approuter/resources-static/logged-out.html'), join(dist, 'logged-out.html'));
console.log(`cloudflare pages output prepared → ${dist}`);
