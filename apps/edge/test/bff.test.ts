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

describe('BFF Fiori proxy', () => {
  const fiori = { ...env, FIORI_URL: 'https://approuter.example' };

  it('forwards /sap to the approuter as the user, with SAP cookies but never the session cookie', async () => {
    const upstream = vi.fn(async (req: Request) => {
      expect(req.url).toBe('https://approuter.example/sap/bc/ui2/flp?sap-client=100');
      expect(req.headers.get('x-approuter-authorization')).toBe('Bearer access-1');
      expect(req.headers.get('authorization')).toBeNull();
      expect(req.headers.get('origin')).toBeNull();
      expect(req.headers.get('cookie')).toBe('sap-usercontext=sap-client=100');
      const res = new Response('<html>launchpad</html>', { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" } });
      res.headers.append('set-cookie', 'SAP_SESSIONID_A4H_100=abc; path=/; secure; HttpOnly; Domain=.example.com');
      res.headers.append('set-cookie', 'JSESSIONID=approuter; path=/');
      return res;
    });
    vi.stubGlobal('fetch', upstream);
    const res = await handle(
      new Request(`${ORIGIN}/sap/bc/ui2/flp?sap-client=100`, { headers: { cookie: `${await sessionCookie({ at: 'access-1', exp: 9e9 })}; sap-usercontext=sap-client=100; JSESSIONID=old` } }),
      fiori,
      page,
    );
    expect(await res.text()).toBe('<html>launchpad</html>');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(res.headers.getSetCookie()).toEqual(['SAP_SESSIONID_A4H_100=abc; path=/; secure; HttpOnly']);
  });

  it('keeps a redirect inside Fiori on this address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://approuter.example/sap/bc/ui2/flp/' } })));
    const res = await handle(new Request(`${ORIGIN}/sap/bc/ui2/flp`, { headers: { cookie: await sessionCookie({ at: 'a', exp: 9e9 }) } }), fiori, page);
    expect(res.headers.get('location')).toBe('/sap/bc/ui2/flp/');
  });

  it('accepts a same-origin form POST that carries Origin: null, as when the launchpad starts SAP GUI for HTML', async () => {
    const upstream = vi.fn(async () => new Response('<html>webgui</html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', upstream);
    const cookie = await sessionCookie({ at: 'a', exp: 9e9 });
    const post = (headers: Record<string, string>) => handle(new Request(`${ORIGIN}/sap/bc/gui/sap/its/webgui`, { method: 'POST', body: 'x', headers: { cookie, ...headers } }), fiori, page);
    expect((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('passes a WebSocket upgrade back untouched, so SAP GUI for HTML keeps its channel', async () => {
    const upgraded = Object.assign(new Response(null, { status: 200 }), { webSocket: {} });
    vi.stubGlobal('fetch', vi.fn(async () => upgraded));
    const res = await handle(
      new Request(`${ORIGIN}/sap/bc/apc/sap/webgui_services`, { headers: { cookie: await sessionCookie({ at: 'a', exp: 9e9 }), origin: ORIGIN, upgrade: 'websocket' } }),
      fiori,
      page,
    );
    expect(res).toBe(upgraded);
  });

  it('asks an unsigned visitor to sign in, refuses another site, and serves nothing under /sap when not configured', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await handle(new Request(`${ORIGIN}/sap/bc/ui2/flp`), fiori, page)).status).toBe(302);
    const cookie = await sessionCookie({ at: 'a', exp: 9e9 });
    expect((await handle(new Request(`${ORIGIN}/sap/x`, { method: 'POST', body: 'x', headers: { cookie, origin: 'https://evil.example' } }), fiori, page)).status).toBe(403);
    expect(await (await handle(new Request(`${ORIGIN}/sap/bc/ui2/flp`, { headers: { cookie } }), env, page)).text()).toBe(html);
    expect(upstream).not.toHaveBeenCalled();
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

  it('allows only the configured Fiori launchpad as a frame', async () => {
    const get = async (extra: Partial<BffEnv>) =>
      (await handle(new Request(`${ORIGIN}/`, { headers: { cookie: await sessionCookie({ at: jwt([]), exp: 9e9 }) } }), { ...env, ...extra }, page)).headers.get('content-security-policy')!;
    expect(await get({})).not.toContain('frame-src');
    expect(await get({ FIORI_ORIGIN: 'https://s4.example.com:44300' })).toContain("frame-src https://s4.example.com:44300; frame-ancestors 'none'");
    expect(await get({ FIORI_ORIGIN: "https://s4.example.com; script-src 'unsafe-inline'" })).not.toContain('frame-src');
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

describe('BFF with IAS sign-in', () => {
  const iasEnv: BffEnv = { ...env, IAS_URL: 'https://tenant.accounts.ondemand.com/', IAS_CLIENT_ID: 'ias-app', IAS_CLIENT_SECRET: 'ias$secret' };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const idToken = (n = 1) => `h.${btoa(JSON.stringify({ email: 'alex@prowess.example', exp, n })).replace(/=+$/, '')}.s`;

  it('signs in at IAS and turns the IAS login into an XSUAA session, keeping the IAS token sealed', async () => {
    const login = await handle(new Request(`${ORIGIN}/login`), iasEnv, page);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://tenant.accounts.ondemand.com/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('ias-app');
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');

    const calls: { url: string; form: URLSearchParams; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));
        calls.push({ url, form, auth: new Headers(init.headers).get('authorization') });
        if (url.startsWith('https://tenant.accounts.ondemand.com')) return Response.json({ id_token: idToken(), refresh_token: 'ias-rt', expires_in: 3600 });
        return Response.json({ access_token: jwt(['app!t1.AI_USER']), refresh_token: 'xs-rt', expires_in: 1800 });
      }),
    );
    const callback = await handle(new Request(`${ORIGIN}/callback?code=c1&state=${authorize.searchParams.get('state')}`, { headers: { cookie: cookieHeader(login) } }), iasEnv, page);
    expect(callback.status).toBe(302);
    expect(calls[0]!.url).toBe('https://tenant.accounts.ondemand.com/oauth2/token');
    expect(calls[0]!.auth).toBe(`Basic ${btoa('ias-app:ias$secret')}`);
    expect(calls[0]!.form.get('code')).toBe('c1');
    expect(calls[1]!.url).toBe('https://tenant.authentication.eu10.hana.ondemand.com/oauth/token');
    expect(calls[1]!.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(calls[1]!.form.get('assertion')).toBe(idToken());

    const sealed = cookieHeader(callback).split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}.0=`))!.split('=')[1]!;
    const session = (await open<Session>(sealed, env.SESSION_SECRET))!;
    expect(session).toMatchObject({ rt: 'xs-rt', it: idToken(), irt: 'ias-rt', iexp: exp });
    expect(cookieHeader(callback)).not.toContain('ias-rt');
  });

  it('fails the sign-in when XSUAA does not accept the IAS login', async () => {
    const login = await handle(new Request(`${ORIGIN}/login`), iasEnv, page);
    const state = new URL(login.headers.get('location')!).searchParams.get('state');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('https://tenant.accounts') ? Response.json({ id_token: idToken() }) : Response.json({ error: 'unauthorized' }, { status: 401 }))),
    );
    const callback = await handle(new Request(`${ORIGIN}/callback?code=c1&state=${state}`, { headers: { cookie: cookieHeader(login) } }), iasEnv, page);
    expect(callback.status).toBe(502);
  });

  it('forwards the IAS token to the orchestrator and never one the browser sent', async () => {
    const upstream = vi.fn(async (req: Request) => {
      expect(req.headers.get('x-prowess-ias-token')).toBe(idToken());
      return Response.json({});
    });
    vi.stubGlobal('fetch', upstream);
    const cookie = await sessionCookie({ at: 'access-1', exp: 9e9, it: idToken(), irt: 'ias-rt', iexp: exp });
    await handle(new Request(`${ORIGIN}/api/v1/workspace`, { headers: { cookie, 'x-prowess-ias-token': 'forged' } }), iasEnv, page);
    expect(upstream).toHaveBeenCalledOnce();

    const plain = vi.fn(async (req: Request) => {
      expect(req.headers.get('x-prowess-ias-token')).toBeNull();
      return Response.json({});
    });
    vi.stubGlobal('fetch', plain);
    await handle(new Request(`${ORIGIN}/api/v1/workspace`, { headers: { cookie: await sessionCookie({ at: 'access-1', exp: 9e9 }), 'x-prowess-ias-token': 'forged' } }), iasEnv, page);
    expect(plain).toHaveBeenCalledOnce();
  });

  it('refreshes an expiring IAS token and keeps the XSUAA session when IAS refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        if (typeof input === 'string') return Response.json({ id_token: idToken(2), expires_in: 3600 });
        expect(input.headers.get('x-prowess-ias-token')).toBe(idToken(2));
        return Response.json({});
      }),
    );
    const stale = await sessionCookie({ at: 'access-1', exp: 9e9, it: idToken(), irt: 'ias-rt', iexp: 1 });
    const res = await handle(new Request(`${ORIGIN}/api/v1/workspace`, { headers: { cookie: stale } }), iasEnv, page);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}.0=`))).toBe(true);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        if (typeof input === 'string') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        expect(input.headers.get('authorization')).toBe('Bearer access-1');
        expect(input.headers.get('x-prowess-ias-token')).toBeNull();
        return Response.json({});
      }),
    );
    const still = await handle(new Request(`${ORIGIN}/api/v1/workspace`, { headers: { cookie: stale } }), iasEnv, page);
    expect(still.status).toBe(200);
  });

  it('logs out at IAS', async () => {
    const res = await handle(new Request(`${ORIGIN}/logout`), iasEnv, page);
    const target = new URL(res.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('https://tenant.accounts.ondemand.com/oauth2/logout');
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/logged-out`);
  });
});
