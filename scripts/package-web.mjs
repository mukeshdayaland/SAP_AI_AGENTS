#!/usr/bin/env node
/**
 * Prepares the approuter module (prowess-ai-web):
 *  1. assembles infrastructure/approuter/dist (package.json, xs-app.json and
 *     the static Next.js export under resources/),
 *  2. computes SHA-256 hashes of every inline <script> Next emitted and pins
 *     them in the Content-Security-Policy — no 'unsafe-inline' for scripts,
 *  3. with FIORI_ORIGIN set, allows that origin as a frame so the Fiori guides
 *     can show the app inside the workspace.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps/web/out');
const approuter = join(root, 'infrastructure/approuter');
const dist = join(approuter, 'dist');
const resources = join(dist, 'resources');

if (!existsSync(out)) throw new Error('apps/web/out not found — run `npm run build -w @prowess/web` first');
rmSync(dist, { recursive: true, force: true });
cpSync(out, resources, { recursive: true });
cpSync(join(approuter, 'package.json'), join(dist, 'package.json'));
cpSync(join(approuter, 'start.mjs'), join(dist, 'start.mjs'));
cpSync(join(approuter, 'resources-static'), resources, { recursive: true });

const hashes = new Set();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.html')) {
      const html = readFileSync(p, 'utf8');
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        if (m[1]) hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
      }
    }
  }
};
walk(resources);

const xsAppPath = join(approuter, 'xs-app.json');
const xsApp = JSON.parse(readFileSync(xsAppPath, 'utf8'));
const csp = xsApp.responseHeaders.find((h) => h.name === 'Content-Security-Policy');
csp.value = csp.value.replace("script-src 'self'", `script-src 'self' ${[...hashes].join(' ')}`.trim());
const fiori = process.env.FIORI_ORIGIN?.trim();
if (fiori) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(fiori)) throw new Error('FIORI_ORIGIN must be an https origin, e.g. https://s4.example.com:44300');
  csp.value = csp.value.replace('frame-ancestors', `frame-src ${fiori}; frame-ancestors`);
}
writeFileSync(join(dist, 'xs-app.json'), `${JSON.stringify(xsApp, null, 2)}\n`);
console.log(`approuter resources prepared (${hashes.size} inline script hashes pinned in CSP)`);
