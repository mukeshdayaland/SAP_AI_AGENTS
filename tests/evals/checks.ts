/**
 * Eval case format and the deterministic checks. Pure functions only, so the
 * scoring is unit-tested without a running stack (see checks.test.ts).
 */

export interface TurnExpect {
  /** Tools that must be called in this turn (MCP names, e.g. `gl_listPaymentRequests`); `a|b` accepts either. */
  tools?: string[];
  /** Tools that must not be called. `*` means no tool at all. */
  notTools?: string[];
  /** Partial match on the arguments the model passed, per tool. */
  args?: Record<string, Record<string, unknown>>;
  /** The turn must (true) or must not (false) stop at a confirmation card. */
  confirmation?: boolean;
  /** Most model calls the turn may take. */
  maxModelCalls?: number;
  answer?: { includes?: string[]; excludes?: string[] };
  /** The turn must be refused with an error containing this text, e.g. `HTTP 403`. */
  error?: string;
}

export interface EvalCase {
  id: string;
  agent: string;
  /** Key of a dev user in the test harness (`alex`, `jordan`, `sam`, `casey`). */
  user: string;
  tags?: string[];
  turns: { ask: string; expect: TurnExpect }[];
}

/** What one turn did, collected from the stream events and the recorded model calls. */
export interface TurnRecord {
  tools: string[];
  /** Tools that returned an error or were denied (a call waiting for confirmation is not a failure). */
  failedTools: string[];
  args: { tool: string; arguments: Record<string, unknown> }[];
  confirmation: boolean;
  modelCalls: number;
  answer: string;
  error?: string;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

const KNOWN = new Set(['tools', 'notTools', 'args', 'confirmation', 'maxModelCalls', 'answer', 'error']);

/** Fails loudly on a malformed case file rather than scoring it as passed. */
export function validateCases(cases: unknown, file: string): EvalCase[] {
  if (!Array.isArray(cases)) throw new Error(`${file}: expected an array of cases`);
  const ids = new Set<string>();
  for (const c of cases as EvalCase[]) {
    const where = `${file}: ${c?.id ?? '(no id)'}`;
    if (!c?.id || !c.agent || !c.user || !Array.isArray(c.turns) || !c.turns.length) throw new Error(`${where}: id, agent, user and turns are required`);
    if (ids.has(c.id)) throw new Error(`${where}: duplicate id`);
    ids.add(c.id);
    for (const t of c.turns) {
      if (!t.ask || !t.expect) throw new Error(`${where}: every turn needs ask and expect`);
      const unknown = Object.keys(t.expect).filter((k) => !KNOWN.has(k));
      if (unknown.length) throw new Error(`${where}: unknown expect keys ${unknown.join(', ')}`);
    }
  }
  return cases as EvalCase[];
}

/** True when every key in `expected` matches `actual`; strings compare case-insensitively. */
export function matchesPartially(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'string' && typeof actual === 'string') return actual.toLowerCase() === expected.toLowerCase();
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => matchesPartially((actual as Record<string, unknown>)[k], v));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function checkTurn(expect: TurnExpect, turn: TurnRecord): CheckResult[] {
  const results: CheckResult[] = [];
  if (expect.error !== undefined) results.push({ check: `fails with ${expect.error}`, pass: !!turn.error?.includes(expect.error), detail: turn.error ?? 'no error' });
  else if (turn.error) results.push({ check: 'no error', pass: false, detail: turn.error });
  for (const tool of expect.tools ?? []) {
    const ok = tool.split('|').some((t) => turn.tools.includes(t) && !turn.failedTools.includes(t));
    const failed = !ok && tool.split('|').some((t) => turn.failedTools.includes(t));
    results.push({
      check: `calls ${tool}`,
      pass: ok,
      detail: failed ? 'the tool failed' : `called: ${turn.tools.join(', ') || 'none'}`,
    });
  }
  for (const tool of expect.notTools ?? []) {
    const pass = tool === '*' ? turn.tools.length === 0 : !turn.tools.includes(tool);
    results.push({ check: tool === '*' ? 'calls no tool' : `does not call ${tool}`, pass, detail: `called: ${turn.tools.join(', ') || 'none'}` });
  }
  for (const [tool, expected] of Object.entries(expect.args ?? {})) {
    const calls = turn.args.filter((a) => a.tool === tool);
    results.push({
      check: `${tool} arguments`,
      pass: calls.some((c) => matchesPartially(c.arguments, expected)),
      detail: calls.length ? JSON.stringify(calls.map((c) => c.arguments)) : 'not called',
    });
  }
  if (expect.confirmation !== undefined) {
    results.push({ check: expect.confirmation ? 'asks for confirmation' : 'no confirmation', pass: turn.confirmation === expect.confirmation });
  }
  if (expect.maxModelCalls !== undefined) {
    results.push({ check: `≤ ${expect.maxModelCalls} model calls`, pass: turn.modelCalls <= expect.maxModelCalls, detail: `${turn.modelCalls}` });
  }
  const answer = turn.answer.toLowerCase();
  for (const s of expect.answer?.includes ?? []) results.push({ check: `answer includes "${s}"`, pass: answer.includes(s.toLowerCase()) });
  for (const s of expect.answer?.excludes ?? []) results.push({ check: `answer excludes "${s}"`, pass: !answer.includes(s.toLowerCase()) });
  return results;
}

/** Case ids that passed in the baseline but fail now. */
export function regressions(baseline: Record<string, boolean>, current: Record<string, boolean>): string[] {
  return Object.entries(current)
    .filter(([id, pass]) => !pass && baseline[id] === true)
    .map(([id]) => id);
}
