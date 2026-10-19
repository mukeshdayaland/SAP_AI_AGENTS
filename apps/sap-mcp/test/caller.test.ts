import { HEADERS, MCP_AUDIENCE, sha256Hex, signAssertion, type PrincipalAssertion } from '@prowess/security';
import { describe, expect, it } from 'vitest';
import { authenticateCaller } from '../src/server.js';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const principal = (extra: Partial<PrincipalAssertion> = {}) =>
  signAssertion<PrincipalAssertion>({ typ: 'principal', sub: 'alex@prowess.example', name: 'Alex', tenant: 't1', roles: ['AI_USER'], env: 'DEV', agent: 'outlook', cid: 'PRW-1', aud: MCP_AUDIENCE, ...extra }, SECRET, 60);

describe('forwarded IAS token', () => {
  it('is accepted when its hash is bound into the signed principal', () => {
    const caller = authenticateCaller({ [HEADERS.principal]: principal({ itk: sha256Hex('ias.token') }), [HEADERS.iasToken]: 'ias.token' }, SECRET, sha256Hex);
    expect(caller.iasToken).toBe('ias.token');
  });

  it('is refused when it differs from the bound one, or is not bound at all', () => {
    expect(() => authenticateCaller({ [HEADERS.principal]: principal({ itk: sha256Hex('ias.token') }), [HEADERS.iasToken]: 'someone.elses' }, SECRET, sha256Hex)).toThrow(/does not match/);
    expect(() => authenticateCaller({ [HEADERS.principal]: principal({ itk: sha256Hex('ias.token') }) }, SECRET, sha256Hex)).toThrow(/does not match/);
    expect(() => authenticateCaller({ [HEADERS.principal]: principal(), [HEADERS.iasToken]: 'ias.token' }, SECRET, sha256Hex)).toThrow(/Unbound IAS token/);
  });

  it('is optional', () => {
    expect(authenticateCaller({ [HEADERS.principal]: principal() }, SECRET, sha256Hex).iasToken).toBeUndefined();
  });
});
