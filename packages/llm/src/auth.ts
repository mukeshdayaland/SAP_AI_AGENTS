import { ProviderError } from './errors.js';

export interface AccessToken {
  token: string;
  expiresAt: number;
}

/**
 * Caches a short-lived token and refreshes it ahead of expiry. Concurrent
 * callers share one in-flight refresh. Tokens are never logged.
 */
export class TokenCache {
  private cached?: AccessToken;
  private inflight?: Promise<AccessToken>;

  constructor(
    private readonly fetchToken: () => Promise<AccessToken>,
    private readonly skewMs = 60_000,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.skewMs > Date.now()) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    this.cached = await this.inflight;
    return this.cached.token;
  }

  invalidate() {
    this.cached = undefined;
  }
}

export interface OAuthClientCredentials {
  provider: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  /** For workload-identity / federated credentials (JWT client assertion). */
  clientAssertion?: () => Promise<string>;
  scope?: string;
  /** `basic` = HTTP Basic auth (SAP XSUAA); `body` = form fields (Entra ID). */
  clientAuth?: 'basic' | 'body';
  fetchImpl?: typeof fetch;
}

export async function fetchClientCredentialsToken(cfg: OAuthClientCredentials): Promise<AccessToken> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (cfg.scope) form.set('scope', cfg.scope);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };

  if (cfg.clientAssertion) {
    form.set('client_id', cfg.clientId);
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', await cfg.clientAssertion());
  } else if (cfg.clientAuth === 'body') {
    form.set('client_id', cfg.clientId);
    form.set('client_secret', cfg.clientSecret ?? '');
  } else {
    headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret ?? ''}`).toString('base64')}`;
  }

  const res = await (cfg.fetchImpl ?? fetch)(cfg.tokenUrl, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error) => {
    throw new ProviderError(cfg.provider, 'unavailable', `Token endpoint unreachable: ${err.message}`);
  });
  if (!res.ok) {
    throw new ProviderError(cfg.provider, 'auth', `Token request failed with HTTP ${res.status}`, res.status);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new ProviderError(cfg.provider, 'auth', 'Token response missing access_token');
  return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000 };
}
