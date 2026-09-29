import { APP_ROLES, type AppRole } from '@prowess/contracts';
import type { Logger } from '@prowess/observability';
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
  ) {}

  static fromVcap(vcap: string | undefined, logger: Logger): XsuaaAuthenticator {
    const services = JSON.parse(vcap ?? '{}') as Record<string, { credentials: Record<string, unknown> }[]>;
    const creds = services.xsuaa?.[0]?.credentials;
    if (!creds) throw new Error('AUTH_MODE=xsuaa requires a bound xsuaa service instance');
    return new XsuaaAuthenticator(creds, logger);
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
      };
    } catch (err) {
      this.logger.warn('auth.token_rejected', { reason: (err as Error).message });
      return null;
    }
  }
}
