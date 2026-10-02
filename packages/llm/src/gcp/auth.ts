import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AccessToken } from '../auth.js';
import { ProviderError } from '../errors.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROVIDER = 'gcp-vertex';

export type GcpAuthConfig =
  /** Development only — paste a short-lived token from `gcloud auth print-access-token`. */
  | { type: 'access-token'; token: string }
  /** Service-account key JSON. Discouraged in production; rotate via secret store. */
  | { type: 'service-account'; keyJson: string }
  /**
   * Workload Identity Federation (recommended): exchanges an OIDC token
   * issued to the workload (e.g. by SAP Cloud Identity Services) for a
   * short-lived Google access token, optionally impersonating a service account.
   */
  | {
      type: 'workload-identity';
      audience: string;
      subjectTokenFile: string;
      subjectTokenType?: string;
      serviceAccountEmail?: string;
    };

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

async function postForm(url: string, form: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ProviderError(PROVIDER, 'auth', `Token exchange at ${new URL(url).host} failed with HTTP ${res.status}`, res.status);
  return (await res.json()) as { access_token: string; expires_in?: number };
}

export function gcpTokenFetcher(cfg: GcpAuthConfig, fetchImpl: typeof fetch = fetch): () => Promise<AccessToken> {
  switch (cfg.type) {
    case 'access-token':
      return async () => ({ token: cfg.token, expiresAt: Date.now() + 50 * 60_000 });

    case 'service-account':
      return async () => {
        const key = JSON.parse(cfg.keyJson) as { client_email: string; private_key: string; token_uri?: string };
        const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
        const iat = Math.floor(Date.now() / 1_000);
        const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
          JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3_600 }),
        )}`;
        const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
        const body = await postForm(
          tokenUri,
          { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` },
          fetchImpl,
        );
        return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000 };
      };

    case 'workload-identity':
      return async () => {
        const subjectToken = (await readFile(cfg.subjectTokenFile, 'utf8')).trim();
        const sts = await postForm(
          'https://sts.googleapis.com/v1/token',
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            audience: cfg.audience,
            scope: SCOPE,
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            subject_token: subjectToken,
            subject_token_type: cfg.subjectTokenType ?? 'urn:ietf:params:oauth:token-type:jwt',
          },
          fetchImpl,
        );
        if (!cfg.serviceAccountEmail) {
          return { token: sts.access_token, expiresAt: Date.now() + (sts.expires_in ?? 3_600) * 1_000 };
        }
        const res = await fetchImpl(
          `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cfg.serviceAccountEmail)}:generateAccessToken`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${sts.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ scope: [SCOPE], lifetime: '3600s' }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) throw new ProviderError(PROVIDER, 'auth', `Service account impersonation failed with HTTP ${res.status}`, res.status);
        const body = (await res.json()) as { accessToken: string; expireTime: string };
        return { token: body.accessToken, expiresAt: Date.parse(body.expireTime) };
      };
  }
}
