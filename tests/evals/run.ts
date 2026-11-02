/**
 * Agent evals: runs the cases in tests/evals/cases against the full stack
 * (orchestrator + SAP MCP with mock SAP, SuccessFactors and Outlook data) and
 * scores tool choice, arguments, confirmations and answer facts.
 *
 *   npm run eval                              mock provider, all cases (CI)
 *   npm run eval -- --provider env --tier standard   providers from the environment (AI Core, …)
 *   npm run eval -- --agent fico --case fico-aging-ap
 *   npm run eval -- --update-baseline         accept the current results
 *
 * Exit code 1 when a case that passed in the baseline fails, or, without a
 * baseline, when any case fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collect, createProvidersFromEnv, MockProvider, type LLMChunk, type LLMProvider, type LLMRequest, type ProviderId } from '@prowess/llm';
import { ofType, startStack, USERS } from '../../apps/orchestrator/test/harness.js';
import { checkTurn, regressions, validateCases, type CheckResult, type EvalCase, type TurnRecord } from './checks.js';

const root = dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({
  options: {
    provider: { type: 'string', default: 'mock' },
    tier: { type: 'string' },
    agent: { type: 'string' },
    case: { type: 'string' },
    'update-baseline': { type: 'boolean', default: false },
  },
});
if (opts.provider !== 'mock' && opts.provider !== 'env') throw new Error('--provider must be "mock" or "env"');
if (opts.provider === 'env' && existsSync('.env')) process.loadEnvFile('.env');

// Every model call of the current turn, recorded on the way through.
let recorded: { modelCalls: number; args: TurnRecord['args'] } = { modelCalls: 0, args: [] };
function recording(provider: LLMProvider): LLMProvider {
  async function* stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    recorded.modelCalls += 1;
    for await (const chunk of provider.stream(req)) {
      if (chunk.type === 'tool_call') recorded.args.push({ tool: chunk.call.name, arguments: chunk.call.arguments });
      yield chunk;
    }
  }
  return { id: provider.id, private: provider.private, stream, complete: (req) => collect(stream(req)), healthCheck: () => provider.healthCheck() };
}

const base: Map<ProviderId, LLMProvider> =
  opts.provider === 'mock' ? new Map([['mock', new MockProvider()]]) : createProvidersFromEnv(process.env, { allowMock: false }).providers;
if (!base.size) throw new Error('No LLM provider is configured in the environment. See docs/llm-providers.md.');
const providers = new Map([...base].map(([id, p]) => [id, recording(p)] as const));

const cases = readdirSync(join(root, 'cases'))
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => validateCases(JSON.parse(readFileSync(join(root, 'cases', f), 'utf8')), f))
  .filter((c) => (!opts.agent || c.agent === opts.agent) && (!opts.case || c.id === opts.case));
if (!cases.length) throw new Error('No eval cases match.');

const stack = await startStack({
  providers,
  env: { ...(opts.provider === 'env' && { LLM_ALLOW_MOCK: 'false', ...(process.env.DEFAULT_LLM_PROVIDER && { DEFAULT_LLM_PROVIDER: process.env.DEFAULT_LLM_PROVIDER }) }) },
});

async function runCase(c: EvalCase) {
  const user = USERS[c.user as keyof typeof USERS];
  if (!user) throw new Error(`${c.id}: unknown user "${c.user}" (one of ${Object.keys(USERS).join(', ')})`);
  let conversationId: string | undefined;
  const turns: { ask: string; record: TurnRecord; checks: CheckResult[] }[] = [];
  for (const t of c.turns) {
    recorded = { modelCalls: 0, args: [] };
    const { status, events, body } = await stack.chat(user, {
      message: t.ask,
      agent: c.agent,
      ...(conversationId && { conversationId }),
      ...(opts.tier && { modelTier: opts.tier }),
    });
    conversationId ??= ofType(events, 'message.start')[0]?.conversationId;
    const failure = status !== 200 ? `HTTP ${status} ${body?.error.code}` : ofType(events, 'error')[0]?.error.message;
    const record: TurnRecord = {
      tools: ofType(events, 'tool.start').map((e) => e.tool.tool),
      failedTools: [
        ...ofType(events, 'tool.error').map((e) => e.tool.tool),
        ...ofType(events, 'tool.complete')
          .filter((e) => e.tool.status === 'error' || e.tool.status === 'denied')
          .map((e) => e.tool.tool),
      ],
      args: recorded.args,
      confirmation: ofType(events, 'confirmation.required').length > 0,
      modelCalls: recorded.modelCalls,
      answer: ofType(events, 'message.delta').map((e) => e.text).join(''),
      ...(failure && { error: failure }),
    };
    turns.push({ ask: t.ask, record, checks: checkTurn(t.expect, record) });
  }
  return { id: c.id, agent: c.agent, tags: c.tags ?? [], pass: turns.every((t) => t.checks.every((r) => r.pass)), turns };
}

const results = [];
try {
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}`);
    for (const t of r.turns) for (const f of t.checks.filter((x) => !x.pass)) console.log(`    ${f.check}${f.detail ? ` — ${f.detail}` : ''}`);
  }
} finally {
  await stack.stop();
}

const byAgent = new Map<string, { pass: number; total: number }>();
for (const r of results) {
  const a = byAgent.get(r.agent) ?? { pass: 0, total: 0 };
  a.total += 1;
  if (r.pass) a.pass += 1;
  byAgent.set(r.agent, a);
}
console.log('');
console.table(Object.fromEntries([...byAgent].map(([agent, a]) => [agent, { passed: a.pass, total: a.total, score: `${Math.round((a.pass / a.total) * 100)}%` }])));

const label = `${opts.provider}-${opts.tier ?? 'default'}`;
const outDir = join(root, '../../test-results/evals');
mkdirSync(outDir, { recursive: true });
const reportFile = join(outDir, `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}-${label}.json`);
writeFileSync(reportFile, JSON.stringify({ provider: opts.provider, tier: opts.tier ?? null, at: new Date().toISOString(), results }, null, 2));
console.log(`Report: ${reportFile}`);

const current = Object.fromEntries(results.map((r) => [r.id, r.pass]));
const baselineFile = join(root, 'baseline', `${label}.json`);
if (opts['update-baseline']) {
  mkdirSync(dirname(baselineFile), { recursive: true });
  const previous = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, boolean>) : {};
  writeFileSync(baselineFile, `${JSON.stringify({ ...previous, ...current }, null, 2)}\n`);
  console.log(`Baseline updated: ${baselineFile}`);
} else if (existsSync(baselineFile)) {
  const lost = regressions(JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, boolean>, current);
  if (lost.length) {
    console.error(`Regressions against the baseline: ${lost.join(', ')}`);
    process.exitCode = 1;
  }
} else if (results.some((r) => !r.pass)) {
  process.exitCode = 1;
}
