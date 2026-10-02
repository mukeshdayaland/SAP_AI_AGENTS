import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AppRole, DeploymentEnvironment } from '@prowess/contracts';

/**
 * Short-lived, HMAC-signed service-to-service assertions.
 *
 * - `principal`: the orchestrator vouches for the authenticated end user on
 *   each MCP call. The MCP server rejects calls without a valid assertion, so
 *   it can never be invoked anonymously or with a forged identity.
 * - `confirmation`: proof that a human explicitly confirmed one specific
 *   write operation (tool + exact arguments + user + environment). MCP write
 *   tools refuse to execute without it, so neither a model nor a compromised
 *   prompt can bypass the confirmation workflow.
 *
 * The signing key is shared only between the orchestrator and MCP services
 * (bound via a BTP user-provided service or credential store — never in Git).
 */

export interface PrincipalAssertion {
  typ: 'principal';
  sub: string;
  name: string;
  tenant: string;
  roles: AppRole[];
  env: DeploymentEnvironment;
  agent: string;
  cid: string;
  aud: string;
  /** SHA-256 of the forwarded end-user token, binding it to this principal. */
  utk?: string;
  iat: number;
  exp: number;
}

export interface ConfirmationAssertion {
  typ: 'confirmation';
  /** Pending action ID in the orchestrator. */
  act: string;
  sub: string;
  tool: string;
  /** SHA-256 of canonical tool arguments. */
  args: string;
  env: DeploymentEnvironment;
  aud: string;
  iat: number;
  exp: number;
}

type Assertion = PrincipalAssertion | ConfirmationAssertion;
type Unsigned<T extends Assertion> = Omit<T, 'iat' | 'exp'>;

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

const MIN_SECRET_LENGTH = 32;

function key(secret: string): Buffer {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new AssertionError(`Service assertion secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return Buffer.from(secret, 'utf8');
}

export function signAssertion<T extends Assertion>(payload: Unsigned<T>, secret: string, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1_000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds })).toString('base64url');
  const sig = createHmac('sha256', key(secret)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAssertion<T extends Assertion>(
  token: string | undefined,
  secret: string,
  expected: { typ: T['typ']; aud: string },
  now = Date.now(),
): T {
  if (!token || token.length > 8_192) throw new AssertionError('Missing assertion');
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) throw new AssertionError('Malformed assertion');
  const expectedSig = createHmac('sha256', key(secret)).update(body).digest();
  const actualSig = Buffer.from(sig, 'base64url');
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    throw new AssertionError('Invalid assertion signature');
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    throw new AssertionError('Malformed assertion payload');
  }
  if (payload.typ !== expected.typ) throw new AssertionError('Unexpected assertion type');
  if (payload.aud !== expected.aud) throw new AssertionError('Unexpected assertion audience');
  const nowSec = Math.floor(now / 1_000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) throw new AssertionError('Assertion expired');
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 30) throw new AssertionError('Assertion issued in the future');
  return payload;
}

/** Deterministic JSON (sorted keys) so argument hashes are stable across services. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashArguments(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

export const HEADERS = {
  principal: 'x-prowess-principal',
  confirmation: 'x-prowess-confirmation',
  /** End-user XSUAA token, forwarded for SAP principal propagation. */
  userToken: 'x-prowess-user-token',
} as const;

export const MCP_AUDIENCE = 'prowess-sap-mcp';
