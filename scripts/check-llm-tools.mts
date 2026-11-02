/**
 * Checks which models behind an OpenAI-compatible endpoint can drive the agents:
 * sends each agent's real system prompt and tool list with one starter question,
 * streamed like the orchestrator does, and reports the tool the model called.
 *
 *   npx tsx scripts/check-llm-tools.mts                  request size per agent (no key needed)
 *   npx tsx scripts/check-llm-tools.mts list             models the endpoint offers
 *   npx tsx scripts/check-llm-tools.mts model-a model-b  run the check
 *
 * Reads OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY from `.env` or the environment.
 * The questions use the demo document numbers of the mock scenarios; nothing is read from SAP.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { isToolAllowed, scopeToAgent } from '../apps/orchestrator/src/agents/registry.js';
import { systemPrompt } from '../apps/orchestrator/src/llm/context.js';
import { buildRegistry } from '../apps/sap-mcp/src/tools/registry.js';
import { BUSINESS_DOMAINS } from '../apps/sap-mcp/src/tools/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const BASE = (process.env.OPENAI_COMPAT_BASE_URL ?? 'http://localhost:20128/v1').replace(/\/+$/, '');
const KEY = process.env.OPENAI_COMPAT_API_KEY ?? '';

const CASES: Record<string, { prompt: string; expect: RegExp }> = {
  fico: { prompt: 'Why is invoice 5100012345 blocked?', expect: /^mm_(analyzeInvoice|getInvoice)$/ },
  mm: { prompt: 'Check purchase order 4200000402 and its goods receipts.', expect: /^mm_(getPurchaseOrder|getGoodsReceipt)$/ },
  sd: { prompt: 'Show the document flow of sales order 648.', expect: /^sd_getSalesOrder(Flow)?$/ },
  hcm: { prompt: 'Show my team overview.', expect: /^sf_getTeamOverview$/ },
};

interface AgentSpec {
  agent: string;
  system: string;
  tools: unknown[];
}

function specs(): AgentSpec[] {
  const agents = (JSON.parse(readFileSync('apps/orchestrator/config/agents.json', 'utf8')) as { agents: { id: string; name: string; description: string; allowedTools: string[]; instructions: string }[] }).agents;
  const registry = [...buildRegistry(new Set(BUSINESS_DOMAINS)).values()];
  return agents
    .filter((agent) => CASES[agent.id])
    .map((agent) => ({
      agent: agent.id,
      system: systemPrompt(agent as never, 'DEV', 'Demo User', new Date(), agents.filter((a) => a.id !== agent.id)),
      // What a user without the power-user role is offered.
      tools: registry
        .filter((t) => !t.internal && !t.requiredRole && isToolAllowed(agent, t.name))
        .flatMap((t) => scopeToAgent(agent, { ...t, inputSchema: z.toJSONSchema(z.object(t.input), { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown> }) ?? [])
        .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }));
}

const isJsonObject = (s: string) => {
  try {
    return typeof JSON.parse(s || '{}') === 'object';
  } catch {
    return false;
  }
};

async function ask(model: string, s: AgentSpec): Promise<{ ok: boolean; note: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: s.system },
        { role: 'user', content: CASES[s.agent]!.prompt },
      ],
      tools: s.tools,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return { ok: false, note: `HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`, ms: Date.now() - started };

  const calls = new Map<number, { name: string; args: string }>();
  let text = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    try {
      const delta = (JSON.parse(line.slice(5)) as { choices?: { delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[] }).choices?.[0]?.delta ?? {};
      text += delta.content ?? '';
      for (const c of delta.tool_calls ?? []) {
        const call = calls.get(c.index ?? 0) ?? { name: '', args: '' };
        call.name += c.function?.name ?? '';
        call.args += c.function?.arguments ?? '';
        calls.set(c.index ?? 0, call);
      }
    } catch {
      // a keep-alive or a line that is not JSON
    }
  }
  const made = [...calls.values()];
  return {
    ok: made.length > 0 && made.every((c) => CASES[s.agent]!.expect.test(c.name) && isJsonObject(c.args)),
    note: made.length ? made.map((c) => `${c.name}(${c.args.slice(0, 60)})`).join(', ') : `no tool call; said: ${text.replace(/\s+/g, ' ').slice(0, 100)}`,
    ms: Date.now() - started,
  };
}

const all = specs();
const models = process.argv.slice(2);
if (!models.length) {
  for (const s of all) console.log(`${s.agent.padEnd(5)} ${String(s.tools.length).padStart(3)} tools  ~${Math.ceil((s.system.length + JSON.stringify(s.tools).length) / 4)} tokens per request`);
} else if (models[0] === 'list') {
  const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } });
  console.log(res.ok ? ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id).join('\n') : `HTTP ${res.status}: ${await res.text()}`);
} else {
  for (const model of models) {
    let passed = 0;
    for (const s of all) {
      const r = await ask(model, s).catch((e: Error) => ({ ok: false, note: e.message, ms: 0 }));
      passed += r.ok ? 1 : 0;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${model}  ${s.agent.padEnd(5)} ${String(r.ms).padStart(6)}ms  ${r.note}`);
    }
    console.log(`=> ${model}: ${passed}/${all.length}\n`);
  }
}
