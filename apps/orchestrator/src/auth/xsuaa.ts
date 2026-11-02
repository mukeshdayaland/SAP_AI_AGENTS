import { APP_ROLES, type AppRole } from '@prowess/contracts';
import type { Logger } from '@prowess/observability';
import { HEADERS } from '@prowess/security';
import type { AuthContext, Authenticator } from './types.js';

/**
 * SAP BTP authentication via the Authorization and Trust Management service
 * (XSUAA). The approuter performs the OAuth login against the corporate IdP
 * (via SAP Cloud Identity Services) and forwards the user's JWT; this class
 * validates its signature, audience and expiry with `@sap/xssec` and maps
 * XSUAA scopes (defined in xs-security.json) to application roles.
 */
export class XsuaaAuthenticator implements Authenticator {
  readonly mode = 'xsuaa' as const;
  private service?: unknown;

  constructor(
    private readonly credentials: Record<string, unknown>,
    private readonly logger: Logger,
    /** Issuer of the Identity Authentication tokens the edge BFF forwards; without it they are ignored. */
    private readonly iasUrl?: string,
  ) {}

  static fromVcap(vcap: string | undefined, logger: Logger, iasUrl?: string): XsuaaAuthenticator {
    const services = JSON.parse(vcap ?? '{}') as Record<string, { credentials: Record<string, unknown> }[]>;
    const creds = services.xsuaa?.[0]?.credentials;
    if (!creds) throw new Error('AUTH_MODE=xsuaa requires a bound xsuaa service instance');
    return new XsuaaAuthenticator(creds, logger, iasUrl);
  }

  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null> {
    const header = headers.authorization;
    const auth = Array.isArray(header) ? header[0] : header;
    if (!auth?.startsWith('Bearer ')) return null;
    const jwt = auth.slice(7);

    const xssec = await import('@sap/xssec');
    this.service ??= new xssec.XsuaaService(this.credentials as never);
    try {
      const ctx = (await xssec.createSecurityContext(this.service as never, { jwt })) as unknown as {
        checkLocalScope(scope: string): boolean;
        getLogonName(): string;
        getEmail(): string;
        getGivenName(): string;
        getFamilyName(): string;
        getZoneId(): string;
        token: { getUserId(): string };
      };
      const roles = APP_ROLES.filter((r) => ctx.checkLocalScope(r)) as AppRole[];
      const given = ctx.getGivenName?.() ?? '';
      const family = ctx.getFamilyName?.() ?? '';
      return {
        user: {
          id: ctx.getLogonName() || ctx.token.getUserId(),
          displayName: `${given} ${family}`.trim() || ctx.getLogonName(),
          email: ctx.getEmail(),
          tenantId: ctx.getZoneId(),
          roles,
        },
        token: jwt,
        ...(this.iasUrl && acceptIasToken(headers[HEADERS.iasToken], this.iasUrl, ctx.getEmail(), this.logger)),
      };
    } catch (err) {
      this.logger.warn('auth.token_rejected', { reason: (err as Error).message });
      return null;
    }
  }
}

/**
 * The forwarded Identity Authentication token, kept only when it was issued by the configured tenant to the same
 * user as the XSUAA token and has not expired. Its signature is checked by IAS itself, which accepts only its own
 * tokens in the Graph token exchange; this check stops a valid token of one user from riding on another's session.
 */
export function acceptIasToken(raw: string | string[] | undefined, iasUrl: string, email: string | undefined, logger: Pick<Logger, 'warn'>): { iasToken?: string } {
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return {};
  let claims: { iss?: string; email?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as typeof claims;
  } catch {
    claims = {};
  }
  const issuer = claims.iss?.replace(/\/+$/, '');
  const sameUser = !!email && claims.email?.toLowerCase() === email.toLowerCase();
  if (issuer !== iasUrl || !sameUser || (claims.exp ?? 0) * 1000 <= Date.now()) {
    logger.warn('auth.ias_token_ignored', { reason: issuer !== iasUrl ? 'issuer' : !sameUser ? 'user' : 'expired' });
    return {};
  }
  return { iasToken: token };
}
