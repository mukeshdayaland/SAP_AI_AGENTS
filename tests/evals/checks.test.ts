import { describe, expect, it } from 'vitest';
import { checkTurn, matchesPartially, regressions, validateCases, type TurnRecord } from './checks.js';

const turn = (patch: Partial<TurnRecord> = {}): TurnRecord => ({
  tools: ['ap_getAging'],
  failedTools: [],
  args: [{ tool: 'ap_getAging', arguments: { companyCode: '1030', currency: 'SAR' } }],
  confirmation: false,
  modelCalls: 2,
  answer: 'Company code 1030 owes SAR 1,120.',
  ...patch,
});
const failed = (expect: Parameters<typeof checkTurn>[0], record = turn()) => checkTurn(expect, record).filter((r) => !r.pass).map((r) => r.check);

describe('eval checks', () => {
  it('passes a turn that meets every expectation', () => {
    expect(
      failed({ tools: ['ap_getAging'], notTools: ['gl_postJournalEntry'], args: { ap_getAging: { companyCode: '1030' } }, confirmation: false, maxModelCalls: 2, answer: { includes: ['sar 1,120'], excludes: ['posted'] } }),
    ).toEqual([]);
  });

  it('fails each expectation the turn misses', () => {
    expect(failed({ tools: ['ar_getAging'] })).toEqual(['calls ar_getAging']);
    expect(failed({ tools: ['ap_getAging'] }, turn({ failedTools: ['ap_getAging'] }))).toEqual(['calls ap_getAging']);
    expect(failed({ tools: ['ar_getAging|ap_getAging'] })).toEqual([]);
    expect(failed({ tools: ['ar_getAging|ap_getAging'] }, turn({ failedTools: ['ap_getAging'] }))).toEqual(['calls ar_getAging|ap_getAging']);
    expect(failed({ notTools: ['*'] })).toEqual(['calls no tool']);
    expect(failed({ args: { ap_getAging: { companyCode: '1010' } } })).toEqual(['ap_getAging arguments']);
    expect(failed({ confirmation: true })).toEqual(['asks for confirmation']);
    expect(failed({ maxModelCalls: 1 })).toEqual(['≤ 1 model calls']);
    expect(failed({ answer: { includes: ['EUR'], excludes: ['owes'] } })).toEqual(['answer includes "EUR"', 'answer excludes "owes"']);
    expect(failed({}, turn({ error: 'HTTP 500' }))).toEqual(['no error']);
    expect(failed({ error: 'HTTP 403' }, turn({ error: 'HTTP 403 FORBIDDEN' }))).toEqual([]);
    expect(failed({ error: 'HTTP 403' })).toEqual(['fails with HTTP 403']);
  });

  it('matches arguments partially and case-insensitively', () => {
    expect(matchesPartially({ a: 'X', b: { c: 1, d: 2 } }, { a: 'x', b: { c: 1 } })).toBe(true);
    expect(matchesPartially({ a: [1, 2] }, { a: [1] })).toBe(false);
    expect(matchesPartially(undefined, { a: 1 })).toBe(false);
  });

  it('reports only cases that passed in the baseline as regressions', () => {
    expect(regressions({ a: true, b: false }, { a: false, b: false, c: false })).toEqual(['a']);
  });

  it('rejects malformed case files', () => {
    expect(() => validateCases({}, 'x.json')).toThrow('expected an array');
    expect(() => validateCases([{ id: 'a', agent: 'fico', user: 'alex', turns: [{ ask: 'q', expect: { tool: ['x'] } }] }], 'x.json')).toThrow('unknown expect keys tool');
    expect(() => validateCases([{ id: 'a', agent: 'fico', user: 'alex', turns: [] }], 'x.json')).toThrow('required');
  });
});
