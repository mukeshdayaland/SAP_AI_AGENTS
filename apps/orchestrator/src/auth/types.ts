import type { AppRole, UserProfile } from '@prowess/contracts';

export interface AuthContext {
  user: UserProfile;
  /** Raw end-user JWT, kept server-side only, forwarded for SAP principal propagation. */
  token?: string;
  /**
   * End-user Identity Authentication token from the edge BFF, server-side only. IAS exchanges it for the user's
   * Microsoft Graph token (corporate IdP Entra ID), so the Outlook tools act as the user without a second login.
   */
  iasToken?: string;
}

/** Pluggable authentication. Implementations must never trust unverified identity input. */
export interface Authenticator {
  readonly mode: 'dev' | 'xsuaa';
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null>;
}

/** The user's tokens as an MCP session forwards them. */
export const tokensOf = (a: AuthContext) => ({ ...(a.token && { userToken: a.token }), ...(a.iasToken && { iasToken: a.iasToken }) });

export function hasRole(user: UserProfile, role: AppRole): boolean {
  return user.roles.includes(role);
}

export function hasAnyRole(user: UserProfile, roles: readonly AppRole[]): boolean {
  return roles.some((r) => user.roles.includes(r));
}
