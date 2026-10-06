/**
 * Encrypted, stateless sessions for the Cloudflare BFF.
 *
 * The XSUAA tokens never reach browser JavaScript: they are sealed with
 * AES-256-GCM (key = SHA-256 of SESSION_SECRET) into HttpOnly `__Host-`
 * cookies, split into chunks because a JWT can exceed one cookie's 4 KB.
 */

export interface Session {
  /** XSUAA access token (JWT) forwarded to the orchestrator. */
  at: string;
  /** XSUAA refresh token. */
  rt?: string;
  /** Access-token expiry, epoch seconds. */
  exp: number;
}

export interface LoginState {
  state: string;
  verifier: string;
  returnTo: string;
  /** Epoch seconds after which the login attempt is void. */
  exp: number;
}

export const SESSION_COOKIE = '__Host-prowess-session';
export const LOGIN_COOKIE = '__Host-prowess-login';
const CHUNK = 3500;
const MAX_CHUNKS = 4;

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys = new Map<string, Promise<AesKey>>();

function key(secret: string): Promise<AesKey> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.digest('SHA-256', enc.encode(secret)).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    keys.set(secret, k);
  }
  return k;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function seal(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

/** Returns undefined for anything tampered, truncated or sealed with another secret. */
export async function open<T>(sealed: string, secret: string): Promise<T | undefined> {
  try {
    const raw = fromB64url(sealed);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await key(secret), raw.slice(12));
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return undefined;
  }
}

export function readCookies(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** Set-Cookie headers for a sealed value split over `name.0 … name.n`; unused chunks are cleared. */
export function chunkedCookies(name: string, sealed: string, maxAgeSeconds: number): string[] {
  const parts = sealed.match(new RegExp(`.{1,${CHUNK}}`, 'g')) ?? [];
  if (parts.length > MAX_CHUNKS) throw new Error('Session too large for cookies');
  return Array.from({ length: MAX_CHUNKS }, (_, i) => (parts[i] ? cookie(`${name}.${i}`, parts[i], maxAgeSeconds) : cookie(`${name}.${i}`, '', 0)));
}

export function readChunked(jar: Map<string, string>, name: string): string | undefined {
  let sealed = '';
  for (let i = 0; i < MAX_CHUNKS && jar.has(`${name}.${i}`); i++) sealed += jar.get(`${name}.${i}`);
  return sealed || undefined;
}

export const clearSessionCookies = (): string[] => Array.from({ length: MAX_CHUNKS }, (_, i) => cookie(`${SESSION_COOKIE}.${i}`, '', 0));
