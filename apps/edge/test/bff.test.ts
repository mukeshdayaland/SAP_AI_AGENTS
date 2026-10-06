import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle, type BffEnv } from '../src/bff.js';
import { SESSION_COOKIE, open, seal, type Session } from '../src/session.js';

const env: BffEnv = {
  ORCHESTRATOR_URL: 'https://orchestrator.example',
  XSUAA_URL: 'https://tenant.authentication.eu10.hana.ondemand.com/',
  XSUAA_CLIENT_ID: 'sb-prowess-ai!t1',
  XSUAA_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'x'.repeat(40),
};
const ORIGIN = 'https://ai.example.com';
const html = '<html><head><script>self.__boot=1</script></head><body>ok</body></html>';
const page = () => Promise.resolve(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

/** A JWT-shaped token whose payload carries the given scopes. */
const jwt = (scope: string[]) => `h.${btoa(JSON.stringify({ scope })).replace(/=+$/, '')}.s`;

/** Turns Set-Cookie headers into a Cookie request header (dropping cleared cookies). */
const cookieHeader = (res: Response, prior = '') => {
  const jar = new Map(prior.split('; ').filter(Boolean).map((c) => c.split('=') as [string, string]));
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const i = pair!.indexOf('=');
    const [name, value] = [pair!.slice(0, i), pair!.slice(i + 1)];
    if (/Max-Age=0\b/.test(sc)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};

async function sessionCookie(session: Session) {
  const sealed = await seal(session, env.SESSION_SECRET);
  return `${SESSION_COOKIE}.0=${sealed}`;
}

afterEach(() => vi.unstubAllGlobals());

describe('session sealing', () => {
  it('round-trips and rejects tampering or another secret', async () => {
    const sealed = await seal({ at: 'a', exp: 1 }, env.SESSION_SECRET);
    expect(await open(sealed, env.SESSION_SECRET)).toEqual({ at: 'a', exp: 1 });
    expect(await open(`${sealed.slice(0, -2)}AA`, env.SESSION_SECRET)).toBeUndefined();
    expect(await open(sealed, 'y'.repeat(40))).toBeUndefined();
  });
});

describe('BFF login flow', () => {
  it('redirects an anonymous page view to /login, keeping the path', async () => {
    const res = await handle(new Request(`${ORIGIN}/admin/?tab=audit`), env, page);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?returnTo=%2Fadmin%2F%3Ftab%3Daudit');
  });

  it('signs in with authorization code + PKCE and stores tokens only in encrypted HttpOnly cookies', async () => {
    const login = await handle(new Request(`${ORIGIN}/login?returnTo=/c/1`), env, page);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://tenant.authentication.eu10.hana.ondemand.com/oauth/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(login.headers.getSetCookie()[0]).toMatch(/^__Host-prowess-login=.+; Path=\/; Secure; HttpOnly; SameSite=Lax/);

    const token = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('the-code');
      expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/);
      expect(form.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
      return Response.json({ access_token: jwt(['app!t1.AI_USER']), refresh_token: 'rt-1', expires_in: 1800 });
    });
    vi.stubGlobal('fetch', token);
    const state = authorize.searchParams.get('state');
    const callback = await handle(new Request(`${ORIGIN}/callback?code=the-code&state=${state}`, { headers: { cookie: cookieHeader(login) } }), env, page);
    expect(token).toHaveBeenCalledOnce();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/c/1');
    const cookies = cookieHeader(callback);
    expect(cookies).toContain(`${SESSION_COOKIE}.0=`);
    expect(cookies).not.toContain('rt-1'); // sealed, never readable
    expect(cookies).not.toContain('__Host-prowess-login');
  });

  it('restarts login on a forged or stale callback instead of exchanging the code', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const res = await handle(new Request(`${ORIGIN}/callback?code=c&state=forged`), env, page);
    expect(res.headers.get('location')).toBe('/login');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never redirects off-site after login', async () => {
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const res = await handle(new Request(`${ORIGIN}/login?returnTo=${encodeURIComponent(evil)}`), env, page);
      const sealed = res.headers.getSetCookie()[0]!.split(';')[0]!.split('=')[1]!;
      expect((await open<{ returnTo: string }>(sealed, env.SESSION_SECRET))!.returnTo).toBe('/');
    }
  });

  it('logs out at XSUAA and clears the session', async () => {
    const res = await handle(new Request(`${ORIGIN}/logout`, { headers: { cookie: await sessionCookie({ at: 'a', exp: 9e9 }) } }), env, page);
    const target = new URL(res.headers.get('location')!);
    expect(target.pathname).toBe('/logout.do');
    expect(target.searchParams.get('redirect')).toBe(`${ORIGIN}/logged-out`);
    expect(cookieHeader(res, await sessionCookie({ at: 'a', exp: 9e9 }))).toBe('');
  });
});

describe('BFF API proxy', () => {
  it('forwards /api with the bearer token and strips browser credentials', async () => {
    const upstream = vi.fn(async (req: Request) => {
      expect(req.url).toBe('https://orchestrator.example/api/v1/chat?x=1');
      expect(req.headers.get('authorization')).toBe('Bearer access-1');
      expect(req.headers.get('cookie')).toBeNull();
      expect(req.headers.get('x-requested-with')).toBe('prowess');
      expect(req.headers.get('x-prowess-dev-user')).toBeNull();
      expect(await req.text()).toBe('{"message":"hi"}');
      return new Response('event: message.delta\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', upstream);
    const res = await handle(
      new Request(`${ORIGIN}/api/v1/chat?x=1`, {
        method: 'POST',
        body: '{"message":"hi"}',
        headers: { cookie: await sessionCookie({ at: 'access-1', exp: 9e9 }), origin: ORIGIN, 'x-requested-with': 'prowess', 'x-prowess-dev-user': 'admin' },
      }),
      env,
      page,
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('message.delta');
  });

  it('refreshes an expiring access token and re-seals the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        if (typeof input === 'string') {
          expect(new URLSearchParams(String(init!.body)).get('grant_type')).toBe('refresh_token');
          return Response.json({ access_token: 'access-2', expires_in: 1800 });
        }
        expect(input.headers.get('authorization')).toBe('Bearer access-2');
        return Response.json({});
      }),
    );
    const res = await handle(new Request(`${ORIGIN}/api/v1/workspace`, { headers: { cookie: await sessionCookie({ at: 'access-1', rt: 'rt-1', exp: 0 }) } }), env, page);
    expect(res.status).toBe(200);
    const sealed = cookieHeader(res).split(`${SESSION_COOKIE}.0=`)[1]!;
    expect(await open<Session>(sealed, env.SESSION_SECRET)).toMatchObject({ at: 'access-2', rt: 'rt-1' });
  });

  it('returns a PublicError 401 without a session and 403 for a foreign origin', async () => {
    const anon = await handle(new Request(`${ORIGIN}/api/v1/workspace`), env, page);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');

    vi.stubGlobal('fetch', vi.fn());
    const foreign = await handle(
      new Request(`${ORIGIN}/api/v1/conversations`, { method: 'POST', headers: { cookie: await sessionCookie({ at: 'a', exp: 9e9 }), origin: 'https://evil.example' } }),
      env,
      page,
    );
    expect(foreign.status).toBe(403);
  });
});

describe('BFF pages', () => {
  it('serves pages with security headers and the inline script pinned by hash', async () => {
    const res = await handle(new Request(`${ORIGIN}/`, { headers: { cookie: await sessionCookie({ at: jwt([]), exp: 9e9 }) } }), env, page);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp.match(/script-src [^;]*/)![0]).not.toContain('unsafe-inline');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(await res.text()).toBe(html);
  });

  it('serves the signed-out page without a session, at both URLs Pages uses', async () => {
    for (const p of ['/logged-out', '/logged-out.html']) {
      expect((await handle(new Request(`${ORIGIN}${p}`), env, page)).status).toBe(200);
    }
  });

  it('limits /admin to admin or auditor scopes', async () => {
    const user = await handle(new Request(`${ORIGIN}/admin/`, { headers: { cookie: await sessionCookie({ at: jwt(['app!t1.AI_USER']), exp: 9e9 }) } }), env, page);
    expect(user.status).toBe(403);
    const admin = await handle(new Request(`${ORIGIN}/admin/`, { headers: { cookie: await sessionCookie({ at: jwt(['app!t1.AI_ADMIN']), exp: 9e9 }) } }), env, page);
    expect(admin.status).toBe(200);
  });
});
