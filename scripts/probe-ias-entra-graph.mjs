#!/usr/bin/env node
/**
 * Probes the single-sign-on path to Microsoft Graph: IAS (with Entra ID as its OIDC corporate IdP)
 * hands back the user's Entra token, which is then used for Graph — no second login.
 *
 * 1. You sign in through the browser to an IAS OIDC application whose default IdP is Entra ID.
 * 2. POST /oauth2/exchange/corporateidp returns the Entra tokens IAS received for you.
 * 3. a) The same exchange with Graph scopes: a Graph token directly, if IAS can refresh for other scopes.
 *    b) Otherwise Entra's on-behalf-of flow turns the token for our app (api://<client id>) into a Graph token.
 * 4. Reads /me, one message and one event as proof.
 *
 * Tokens and secrets are never printed; only their claims that explain the result (aud, scp, upn).
 * The credentials come from a JSON file you write outside the repository:
 *
 *   {
 *     "ias":   { "url": "https://atpuewibz.accounts.ondemand.com", "clientid": "…", "clientsecret": "…" },
 *     "entra": { "tenant": "9cbe9f33-3135-484a-b3bf-767c37112427", "clientid": "e214b066-6d2b-4a27-8f72-8a1d17af0999", "clientsecret": "…" }
 *   }
 *
 *   node scripts/probe-ias-entra-graph.mjs <credentials.json>
 *
 * The IAS application must list http://localhost:8765/callback as a redirect URI (see docs/outlook.md).
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/probe-ias-entra-graph.mjs <credentials.json>');
  process.exit(2);
}
const { ias, entra, xsuaa } = JSON.parse(readFileSync(file, 'utf8'));
for (const [name, value] of [['ias.url', ias?.url], ['ias.clientid', ias?.clientid], ['ias.clientsecret', ias?.clientsecret], ['entra.tenant', entra?.tenant], ['entra.clientid', entra?.clientid]]) {
  if (!value) {
    console.error(`${name} is missing in ${file}.`);
    process.exit(2);
  }
}
const IAS = ias.url.replace(/\/+$/, '');
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const GRAPH_SCOPES = 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.Read';

/** Basic credentials as RFC 7617 writes them; IAS does not URL-decode them. */
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};
/** What a token is for, without the token. */
const describe = (jwt) => {
  const c = claims(jwt);
  if (!c) return '(opaque token, not a JWT)';
  const scopes = c.scp ?? (Array.isArray(c.roles) ? c.roles.join(' ') : undefined);
  return `aud=${c.aud} ${scopes ? `scp="${scopes}" ` : ''}user=${c.upn ?? c.preferred_username ?? c.email ?? c.sub} tid=${c.tid ?? '-'} expires=${c.exp ? new Date(c.exp * 1000).toISOString() : '-'}`;
};

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers }, body: new URLSearchParams(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, json };
}

const errorOf = (r) => `HTTP ${r.status}: ${r.json.error ?? ''} ${r.json.error_description ?? r.json.raw ?? JSON.stringify(r.json).slice(0, 300)}`.trim();

/** Authorization code flow with PKCE against the IAS OIDC application. */
function signIn() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = `${IAS}/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: ias.clientid, redirect_uri: REDIRECT, scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256' })}`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT);
      if (url.pathname !== '/callback') return res.writeHead(404).end();
      try {
        if (url.searchParams.get('state') !== state) throw new Error('The login answer does not belong to this probe (state mismatch).');
        if (url.searchParams.get('error')) throw new Error(`Login failed: ${url.searchParams.get('error')} ${url.searchParams.get('error_description') ?? ''}`);
        const r = await post(`${IAS}/oauth2/token`, { grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: REDIRECT, code_verifier: verifier }, { authorization: basic(ias.clientid, ias.clientsecret) });
        if (!r.ok) throw new Error(`IAS token endpoint: ${errorOf(r)}`);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Signed in. You can close this tab and return to the terminal.');
        resolve(r.json);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err.message));
        reject(err);
      } finally {
        server.close();
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\n1) Sign in in the browser. If it does not open, visit:\n   ${authorize}\n`);
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', authorize.replaceAll('&', '^&')]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [authorize]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    });
    setTimeout(() => {
      server.close();
      reject(new Error('No login within 5 minutes.'));
    }, 300_000).unref();
  });
}

/** Asks IAS for the corporate IdP's tokens, trying each IAS token the login returned as the assertion. */
async function corporateToken(tokens, scope) {
  const tried = [];
  for (const kind of ['id_token', 'access_token', 'refresh_token']) {
    if (!tokens[kind]) continue;
    const r = await post(`${IAS}/oauth2/exchange/corporateidp`, { assertion: tokens[kind], response_type: 'token', ...(scope && { scope }) }, { authorization: basic(ias.clientid, ias.clientsecret) });
    if (r.ok && r.json.access_token) return { token: r.json.access_token, assertion: kind };
    tried.push(`${kind} → ${errorOf(r)}`);
  }
  return { tried };
}

async function graph(token, path) {
  const res = await fetch(`https://graph.microsoft.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function proveGraph(token) {
  const me = await graph(token, '/v1.0/me?$select=displayName,userPrincipalName');
  console.log(`   /me:          HTTP ${me.status}`, me.status === 200 ? `${me.body.displayName} <${me.body.userPrincipalName}>` : JSON.stringify(me.body.error ?? me.body));
  const mail = await graph(token, '/v1.0/me/messages?$top=1&$select=subject');
  console.log(`   /me/messages: HTTP ${mail.status}`, mail.status === 200 ? `${mail.body.value?.length ?? 0} message(s) readable` : JSON.stringify(mail.body.error ?? mail.body));
  const cal = await graph(token, '/v1.0/me/events?$top=1&$select=subject');
  console.log(`   /me/events:   HTTP ${cal.status}`, cal.status === 200 ? 'calendar readable' : JSON.stringify(cal.body.error ?? cal.body));
  return me.status === 200;
}

try {
  const tokens = await signIn();
  const id = claims(tokens.id_token) ?? {};
  console.log('2) IAS login');
  console.log(`   user: ${id.email ?? id.sub}  issuer: ${id.iss}  tokens: ${['id_token', 'access_token', 'refresh_token'].filter((k) => tokens[k]).join(', ')}`);

  if (xsuaa?.url) {
    // The workspace backend works with XSUAA tokens (roles, S/4HANA and SuccessFactors propagation): can the IAS login become one?
    const x = await post(`${xsuaa.url.replace(/\/+$/, '')}/oauth/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: tokens.id_token, client_id: xsuaa.clientid, client_secret: xsuaa.clientsecret, response_type: 'token' });
    if (x.ok) {
      const c = claims(x.json.access_token) ?? {};
      console.log(`\n2b) XSUAA token from the IAS login: user_name=${c.user_name} email=${c.email} origin=${c.origin} refresh=${x.json.refresh_token ? 'yes' : 'no'}`);
      console.log(`    scopes: ${(c.scope ?? []).filter((s) => !s.startsWith('openid')).join(', ') || '(none)'}`);
    } else {
      console.log(`\n2b) XSUAA refused the IAS token: ${errorOf(x)}`);
    }
  }

  console.log('\n3) IAS corporate IdP exchange (default scopes)');
  const base = await corporateToken(tokens);
  if (!base.token) {
    console.log(`   refused:\n   - ${base.tried.join('\n   - ')}`);
    console.log('\n   Check: the IAS application uses Prowess Entra ID as its default identity provider, and you signed in through it.');
    process.exit(1);
  }
  console.log(`   Entra token (assertion: IAS ${base.assertion}): ${describe(base.token)}`);

  console.log('\n4a) Same exchange with Graph scopes (direct Graph token)');
  const direct = await corporateToken(tokens, GRAPH_SCOPES);
  if (direct.token) {
    console.log(`   ${describe(direct.token)}`);
    if (await proveGraph(direct.token)) {
      console.log('\nResult: IAS returns a Graph token directly. No on-behalf-of step and no Entra secret in the backend needed.');
      process.exit(0);
    }
  } else {
    console.log(`   not available:\n   - ${direct.tried.join('\n   - ')}`);
  }

  console.log('\n4b) Entra on-behalf-of: token for our app → Graph token');
  if (!entra.clientsecret) {
    console.log('   Skipped: add entra.clientsecret to the credentials file to try it.');
    process.exit(1);
  }
  const obo = await post(`https://login.microsoftonline.com/${entra.tenant}/oauth2/v2.0/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: entra.clientid,
    client_secret: entra.clientsecret,
    assertion: base.token,
    scope: 'https://graph.microsoft.com/.default',
    requested_token_use: 'on_behalf_of',
  });
  if (!obo.ok) {
    console.log(`   refused: ${errorOf(obo)}`);
    const code = /AADSTS\d+/.exec(JSON.stringify(obo.json))?.[0];
    if (code) console.log(`   Look up ${code}: https://login.microsoftonline.com/error?code=${code.slice(6)}`);
    console.log('   The token from step 3 must have aud = api://<client id> (the access_as_user scope in the IAS corporate IdP scopes).');
    process.exit(1);
  }
  console.log(`   ${describe(obo.json.access_token)}`);
  const works = await proveGraph(obo.json.access_token);
  console.log(works ? '\nResult: the single sign-on path works: IAS → Entra token → on-behalf-of → Graph.' : '\nA Graph token came back but Graph refused it; see above.');
  process.exit(works ? 0 : 1);
} catch (err) {
  console.error(`\nProbe failed: ${err.message}`);
  process.exit(1);
}
