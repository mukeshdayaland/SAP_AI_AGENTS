#!/usr/bin/env node
/**
 * Bundles a Node service into `apps/<app>/dist/server.mjs` for Cloud Foundry.
 * Workspace packages (@prowess/*) are inlined; third-party dependencies stay
 * external and are listed in a generated dist/package.json, so `cf push`
 * installs exactly the runtime dependencies — no monorepo symlinks needed.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = process.argv[2];
if (!app) throw new Error('usage: bundle.mjs <app>');
const appDir = join(root, 'apps', app);
const dist = join(appDir, 'dist');
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));

// Collect third-party deps from the app and the workspace packages it inlines.
const external = {};
const collect = (deps = {}) => {
  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith('@prowess/')) {
      const p = JSON.parse(readFileSync(join(root, 'packages', name.split('/')[1], 'package.json'), 'utf8'));
      collect(p.dependencies);
    } else external[name] = version;
  }
};
collect(pkg.dependencies);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(appDir, 'src/main.ts')],
  outfile: join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(external).flatMap((n) => [n, `${n}/*`]),
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

writeFileSync(
  join(dist, 'package.json'),
  JSON.stringify(
    {
      name: `prowess-${app}`,
      version: pkg.version,
      private: true,
      type: 'module',
      engines: { node: '>=22' },
      scripts: { start: 'node --enable-source-maps server.mjs' },
      dependencies: external,
    },
    null,
    2,
  ),
);
if (existsSync(join(appDir, 'config'))) cpSync(join(appDir, 'config'), join(dist, 'config'), { recursive: true });
console.log(`bundled ${app} → ${dist}`);
