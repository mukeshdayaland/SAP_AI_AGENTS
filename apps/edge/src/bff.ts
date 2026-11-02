import type { PublicError } from '@prowess/contracts';
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  b64url,
  chunkedCookies,
  clearSessionCookies,
  cookie,
  open,
  readChunked,
  readCookies,
  seal,
  type LoginState,
  type Session,
} from './session.js';

/**
 * Backend-for-frontend on Cloudflare Pages Functions. Replaces the SAP
 * approuter: it signs users in against XSUAA (authorization code + PKCE) or,
 * with IAS_URL set, against the IAS application the subaccount's XSUAA trusts,
 * turning that IAS login into an XSUAA token (JWT bearer) and keeping the IAS
 * token for the Outlook tools' Graph token exchange. Either way it
 * keeps the tokens in an encrypted HttpOnly cookie on the custom domain, and
 * proxies same-origin `/api/*` calls to the orchestrator on SAP BTP with the
 * user's bearer token. The browser never holds a token and never talks to
 * BTP directly, so the orchestrator still needs no CORS.
 */

export interface BffEnv {
  /** Orchestrator base URL on SAP BTP, e.g. https://prowess-ai-orchestrator-….cfapps.eu10-005.hana.ondemand.com */
  ORCHESTRATOR_URL: string;
  /** XSUAA `url` from the service key, e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com */
  XSUAA_URL: string;
  XSUAA_CLIENT_ID: string;
  XSUAA_CLIENT_SECRET: string;
  /** ≥ 32 random characters; rotating it signs everyone out. */
  SESSION_SECRET: string;
  /**
   * SAP Cloud Identity Services tenant, e.g. https://<tenant>.accounts.ondemand.com. With it, users sign in through
   * IAS (and its corporate IdP) to the application with IAS_CLIENT_ID, which must be the one XSUAA trusts.
   */
  IAS_URL?: string;
  IAS_CLIENT_ID?: string;
  IAS_CLIENT_SECRET?: string;
  /** Origin of the SAP Fiori launchpad, e.g. https://s4.example.com:44300. Lets the Fiori guides show the app inside the workspace. */
  FIORI_ORIGIN?: string;
  /** The approuter on SAP BTP that forwards `/sap/*` to S/4HANA as the signed-in user. With it set, this site serves Fiori under `/sap/` too. */
  FIORI_URL?: string;
}

type Next = () => Promise<Response>;

/** XSUAA's refresh-token validity in xs-security.json (8 h). */
const SESSION_MAX_AGE = 8 * 3600;
const LOGIN_MAX_AGE = 600;
/** Refresh this many seconds before the access token expires. */
const REFRESH_SKEW = 60;
/** The orchestrator's header for the user's IAS token (HEADERS.iasToken in @prowess/security). */
const IAS_TOKEN_HEADER = 'x-prowess-ias-token';
/** Pages serves `logged-out.html` at `/logged-out` (it 308-redirects `.html` URLs). */
const PUBLIC_PATHS = new Set(['/logged-out', '/logged-out.html', '/icon.svg']);
/** Never forwarded to the orchestrator: the session cookie and anything the browser claims about auth or origin. */
const DROP_HEADERS = ['cookie', 'authorization', 'origin', 'referer', 'host', 'x-prowess-dev-user', IAS_TOKEN_HEADER];

/**
 * Same policy as the approuter's xs-app.json. Pages' `_headers` file does not
 * apply to responses that pass through Functions, so the BFF sets them; for
 * HTML it pins each inline <script> by hash — no 'unsafe-inline' for scripts.
 */
const CSP =
  "default-src 'self'; script-src 'self' https://maps.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com; connect-src 'self' https://*.googleapis.com https://*.gstatic.com; font-src 'self' https://fonts.gstatic.com; worker-src blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

const now = () => Math.floor(Date.now() / 1000);

export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1]) continue;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1])));
    hashes.add(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
  }
  return [...hashes];
}

/** The policy with the Fiori launchpad allowed as a frame; any other frame stays blocked by default-src. */
function cspFor(env: BffEnv): string {
  const origin = env.FIORI_ORIGIN?.trim();
  return origin && /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin) ? CSP.replace('frame-ancestors', `frame-src ${origin}; frame-ancestors`) : CSP;
}

async function secured(res: Response, cookies: string[], env: BffEnv): Promise<Response> {
  const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
  const html = isHtml ? await res.text() : undefined;
  const out = new Response(html ?? res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  const hashes = html ? await inlineScriptHashes(html) : [];
  out.headers.set('content-security-policy', cspFor(env).replace("script-src 'self'", `script-src 'self'${hashes.map((h) => ` ${h}`).join('')}`));
  if (isHtml) out.headers.set('cache-control', 'no-cache');
  for (const c of cookies) out.headers.append('set-cookie', c);
  return out;
}

function json(status: number, error: Pick<PublicError, 'code' | 'message' | 'category'>, extra: string[] = []): Response {
  const body: { error: PublicError } = { error: { ...error, correlationId: '', reference: '', retryable: false } };
  const res = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  for (const c of extra) res.headers.append('set-cookie', c);
  return res;
}

function redirect(location: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
}

/** Only same-site relative paths, so /login?returnTo= cannot be used as an open redirect. */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

function tokenSession(t: { access_token: string; refresh_token?: string; expires_in?: number }): Session {
  return { at: t.access_token, ...(t.refresh_token && { rt: t.refresh_token }), exp: now() + (t.expires_in ?? 1800) };
}

async function tokenRequest(env: BffEnv, params: Record<string, string>): Promise<Session | undefined> {
  const res = await fetch(`${env.XSUAA_URL.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: env.XSUAA_CLIENT_ID, client_secret: env.XSUAA_CLIENT_SECRET }),
  });
  if (!res.ok) {
    // XSUAA's own reason (e.g. "unauthorized: Bad credentials", "invalid_grant") for the function log; it holds no secret.
    const reason = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    console.error(`XSUAA ${params.grant_type} failed: ${res.status} ${reason.error ?? ''} ${reason.error_description ?? ''}`);
    return undefined;
  }
  return tokenSession((await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number });
}

const iasMode = (env: BffEnv) => !!(env.IAS_URL && env.IAS_CLIENT_ID && env.IAS_CLIENT_SECRET);
const iasBase = (env: BffEnv) => env.IAS_URL!.replace(/\/+$/, '');

/** Claims of a JWT, read without verification: it came straight from IAS over TLS. */
function claimsOf(jwt: string | undefined): { exp?: number } {
  try {
    return JSON.parse(atob(jwt!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
  } catch {
    return {};
  }
}

/** An IAS token request; IAS authenticates the client with Basic credentials, written as they are. */
async function iasTokenRequest(env: BffEnv, params: Record<string, string>): Promise<{ it: string; irt?: string; iexp: number } | undefined> {
  const res = await fetch(`${iasBase(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${btoa(`${env.IAS_CLIENT_ID}:${env.IAS_CLIENT_SECRET}`)}` },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) {
    console.error(`IAS ${params.grant_type} failed: ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`);
    return undefined;
  }
  return { it: body.id_token, ...(body.refresh_token && { irt: body.refresh_token }), iexp: claimsOf(body.id_token).exp ?? now() + (body.expires_in ?? 3600) };
}

/** The XSUAA session for an IAS sign-in: XSUAA accepts ID tokens of the IAS application it trusts (JWT bearer). */
function xsuaaFromIas(env: BffEnv, idToken: string): Promise<Session | undefined> {
  return tokenRequest(env, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: idToken, response_type: 'token' });
}

/** JWT scopes, read without verification — the token came straight from XSUAA over TLS, and the orchestrator verifies it. */
export function scopes(jwt: string): string[] {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { scope?: string[] };
    return payload.scope ?? [];
  } catch {
    return [];
  }
}

async function startLogin(url: URL, env: BffEnv): Promise<Response> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const login: LoginState = { state: b64url(crypto.getRandomValues(new Uint8Array(16))), verifier, returnTo: safeReturnTo(url.searchParams.get('returnTo')), exp: now() + LOGIN_MAX_AGE };
  const ias = iasMode(env);
  const authorize = new URL(ias ? `${iasBase(env)}/oauth2/authorize` : `${env.XSUAA_URL.replace(/\/+$/, '')}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ias ? env.IAS_CLIENT_ID! : env.XSUAA_CLIENT_ID,
    ...(ias && { scope: 'openid email profile' }),
    redirect_uri: `${url.origin}/callback`,
    state: login.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return redirect(authorize.toString(), [cookie(LOGIN_COOKIE, await seal(login, env.SESSION_SECRET), LOGIN_MAX_AGE)]);
}

async function finishLogin(req: Request, url: URL, env: BffEnv): Promise<Response> {
  const login = await open<LoginState>(readCookies(req.headers.get('cookie')).get(LOGIN_COOKIE) ?? '', env.SESSION_SECRET);
  const code = url.searchParams.get('code');
  if (!login || login.exp < now() || !code || url.searchParams.get('state') !== login.state) {
    // Stale or forged callback: start over rather than show an error page.
    return redirect('/login', [cookie(LOGIN_COOKIE, '', 0)]);
  }
  const grant = { grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/callback`, code_verifier: login.verifier };
  let session: Session | undefined;
  if (iasMode(env)) {
    const ias = await iasTokenRequest(env, grant);
    const xsuaa = ias && (await xsuaaFromIas(env, ias.it));
    session = xsuaa && { ...xsuaa, ...ias };
  } else {
    session = await tokenRequest(env, grant);
  }
  if (!session) return json(502, { code: 'LOGIN_FAILED', message: 'Sign-in could not be completed. Please try again.', category: 'AUTHENTICATION' }, [cookie(LOGIN_COOKIE, '', 0)]);
  return redirect(login.returnTo, [cookie(LOGIN_COOKIE, '', 0), ...chunkedCookies(SESSION_COOKIE, await seal(session, env.SESSION_SECRET), SESSION_MAX_AGE)]);
}

function logout(url: URL, env: BffEnv): Response {
  if (iasMode(env)) {
    // The IAS session is the single sign-on session; XSUAA holds none for this site (its tokens came by JWT bearer).
    const target = new URL(`${iasBase(env)}/oauth2/logout`);
    target.search = new URLSearchParams({ client_id: env.IAS_CLIENT_ID!, post_logout_redirect_uri: `${url.origin}/logged-out` }).toString();
    return redirect(target.toString(), clearSessionCookies());
  }
  const target = new URL(`${env.XSUAA_URL.replace(/\/+$/, '')}/logout.do`);
  target.search = new URLSearchParams({ redirect: `${url.origin}/logged-out`, client_id: env.XSUAA_CLIENT_ID }).toString();
  return redirect(target.toString(), clearSessionCookies());
}

/** Reads the session and refreshes it when the access token is about to expire. `cookies` carries any re-sealed session. */
async function currentSession(req: Request, env: BffEnv): Promise<{ session?: Session; cookies: string[] }> {
  const sealed = readChunked(readCookies(req.headers.get('cookie')), SESSION_COOKIE);
  const session = sealed ? await open<Session>(sealed, env.SESSION_SECRET) : undefined;
  if (!session) return { cookies: [] };
  const xsuaaFresh = session.exp - REFRESH_SKEW > now();
  const iasFresh = !session.irt || (session.iexp ?? 0) - REFRESH_SKEW > now();
  if (xsuaaFresh && iasFresh) return { session, cookies: [] };

  let next: Session = session;
  if (!iasFresh) {
    // A lapsed IAS token only switches Outlook off; the workspace keeps working on the XSUAA session.
    const ias = await iasTokenRequest(env, { grant_type: 'refresh_token', refresh_token: session.irt! });
    const { it: _it, irt: _irt, iexp: _iexp, ...rest } = next;
    next = ias ? { ...rest, ...ias, irt: ias.irt ?? session.irt } : rest;
  }
  if (!xsuaaFresh) {
    const refreshed =
      (session.rt ? await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: session.rt }) : undefined) ??
      (next.it && (next.iexp ?? 0) > now() ? await xsuaaFromIas(env, next.it) : undefined);
    if (!refreshed) return { cookies: clearSessionCookies() };
    next = { ...next, ...refreshed, rt: refreshed.rt ?? session.rt } as Session;
  }
  return { session: next, cookies: chunkedCookies(SESSION_COOKIE, await seal(next, env.SESSION_SECRET), SESSION_MAX_AGE) };
}

async function proxy(req: Request, url: URL, env: BffEnv, session: Session): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of DROP_HEADERS) headers.delete(h);
  headers.set('authorization', `Bearer ${session.at}`);
  if (session.it && (session.iexp ?? 0) > now()) headers.set(IAS_TOKEN_HEADER, session.it);
  const ip = req.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  const target = new URL(url.pathname + url.search, env.ORCHESTRATOR_URL);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(
    new Request(target, { method: req.method, headers, redirect: 'manual', ...(hasBody && { body: req.body, duplex: 'half' }) } as RequestInit),
  );
  // Re-wrap so headers are mutable; the body (including chat SSE) streams through untouched.
  return new Response(upstream.body, upstream);
}

/** Session cookies of the approuter itself: the BFF signs in with a token on every request and keeps no approuter session. */
const APPROUTER_COOKIES = /^(JSESSIONID|__VCAP_ID__|__VCAP_ID_META__)=/i;

/**
 * Fiori on the workspace's own address, so the agent can work in the page (docs/sap-connectivity.md, Fiori pane).
 * Only the approuter on BTP can reach S/4HANA as the signed-in user, so `/sap/*` goes there with the user's token.
 * SAP's own cookies pass both ways; the BFF's session cookie never leaves.
 */
async function proxyFiori(req: Request, url: URL, base: string, session: Session): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of ['authorization', 'origin', 'referer', 'host', 'x-prowess-dev-user']) headers.delete(h);
  const cookies = (req.headers.get('cookie') ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(SESSION_COOKIE) && !c.startsWith(LOGIN_COOKIE) && !APPROUTER_COOKIES.test(c));
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  else headers.delete('cookie');
  headers.set('x-approuter-authorization', `Bearer ${session.at}`);
  const target = new URL(url.pathname + url.search, base);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(new Request(target, { method: req.method, headers, redirect: 'manual', ...(hasBody && { body: req.body, duplex: 'half' }) } as RequestInit));
  // A WebSocket upgrade (SAP GUI for HTML talks to SAP over one) goes back as it came: a re-wrapped response loses the socket.
  if ((upstream as Response & { webSocket?: unknown }).webSocket) return upstream;

  const res = new Response(upstream.body, upstream);
  const setCookies = upstream.headers.getSetCookie().filter((c) => !APPROUTER_COOKIES.test(c));
  res.headers.delete('set-cookie');
  // Host-only on this address, whatever domain SAP names.
  for (const c of setCookies) res.headers.append('set-cookie', c.replace(/;\s*domain=[^;]*/i, ''));
  // A redirect within Fiori stays on this address.
  const location = upstream.headers.get('location');
  if (location?.startsWith(target.origin)) res.headers.set('location', location.slice(target.origin.length) || '/');
  // Fiori runs under its own rules, not the workspace's policy; the one rule set here: only this site may frame it.
  res.headers.set('content-security-policy', "frame-ancestors 'self'");
  return res;
}

export async function handle(req: Request, env: BffEnv, next: Next): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/login') return startLogin(url, env);
  if (path === '/callback') return finishLogin(req, url, env);
  if (path === '/logout') return logout(url, env);
  if (PUBLIC_PATHS.has(path)) return secured(await next(), [], env);

  const { session, cookies } = await currentSession(req, env);

  if (path.startsWith('/api/')) {
    if (!session) {
      return json(401, { code: 'UNAUTHENTICATED', message: 'Your session has expired. Please reload the page to sign in again.', category: 'AUTHENTICATION' }, cookies);
    }
    // The orchestrator enforces CSRF via x-requested-with; also refuse cross-site origins outright.
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return json(403, { code: 'ORIGIN_REJECTED', message: 'The request origin is not allowed.', category: 'AUTHORIZATION' });
    const res = await proxy(req, url, env, session);
    for (const c of cookies) res.headers.append('set-cookie', c);
    return res;
  }

  if (!session) {
    if (req.method === 'GET' || req.method === 'HEAD') return redirect(`/login?returnTo=${encodeURIComponent(path + url.search)}`, cookies);
    return new Response('Unauthorized', { status: 401 });
  }
  if (path.startsWith('/sap/') && env.FIORI_URL) {
    const origin = req.headers.get('origin');
    // Under a no-referrer policy the browser sends `Origin: null` on a form POST, as when the launchpad starts an
    // SAP GUI for HTML app. Sec-Fetch-Site is set by the browser itself and cannot be forged by a page.
    const sameOrigin = !origin || origin === url.origin || req.headers.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) {
      console.warn(`Fiori request refused: ${req.method} ${path} origin=${origin} sec-fetch-site=${req.headers.get('sec-fetch-site') ?? '-'}`);
      return new Response('The request origin is not allowed.', { status: 403 });
    }
    const res = await proxyFiori(req, url, env.FIORI_URL, session);
    // The headers of a WebSocket upgrade are immutable; a refreshed session is stored with the next page request.
    if (res.status !== 101) for (const c of cookies) res.headers.append('set-cookie', c);
    return res;
  }
  // Mirrors the approuter route: the admin console needs an admin or auditor scope.
  if (/^\/admin(\/|$)/.test(path) && !scopes(session.at).some((s) => s.endsWith('.AI_ADMIN') || s.endsWith('.AI_AUDITOR'))) {
    return new Response('You do not have access to the admin console.', { status: 403, headers: { 'content-type': 'text/plain' } });
  }
  return secured(await next(), cookies, env);
}
