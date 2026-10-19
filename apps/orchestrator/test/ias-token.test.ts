import { describe, expect, it } from 'vitest';
import { acceptIasToken } from '../src/auth/xsuaa.js';

const IAS = 'https://tenant.accounts.ondemand.com';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const valid = { iss: `${IAS}/`, email: 'Alex@Prowess.example', exp: Math.floor(Date.now() / 1000) + 600 };
const warnings: unknown[] = [];
const logger = { warn: (...args: unknown[]) => void warnings.push(args) };

describe('forwarded IAS token', () => {
  it("is kept for the XSUAA token's own user from the configured tenant", () => {
    expect(acceptIasToken(jwt(valid), IAS, 'alex@prowess.example', logger)).toEqual({ iasToken: jwt(valid) });
  });

  it('is dropped for another user, another issuer, or when expired', () => {
    expect(acceptIasToken(jwt(valid), IAS, 'jordan@prowess.example', logger)).toEqual({});
    expect(acceptIasToken(jwt({ ...valid, iss: 'https://evil.example' }), IAS, 'alex@prowess.example', logger)).toEqual({});
    expect(acceptIasToken(jwt({ ...valid, exp: 1 }), IAS, 'alex@prowess.example', logger)).toEqual({});
    expect(acceptIasToken('not-a-jwt', IAS, 'alex@prowess.example', logger)).toEqual({});
    expect(acceptIasToken(undefined, IAS, 'alex@prowess.example', logger)).toEqual({});
  });
});
