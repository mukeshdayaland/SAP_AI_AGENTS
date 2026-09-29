import type { AppRole, UserProfile } from '@prowess/contracts';

export interface AuthContext {
  user: UserProfile;
  /** Raw end-user JWT, kept server-side only, forwarded for SAP principal propagation. */
  token?: string;
}

/** Pluggable authentication. Implementations must never trust unverified identity input. */
export interface Authenticator {
  readonly mode: 'dev' | 'xsuaa';
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null>;
}

export function hasRole(user: UserProfile, role: AppRole): boolean {
  return user.roles.includes(role);
}

export function hasAnyRole(user: UserProfile, roles: readonly AppRole[]): boolean {
  return roles.some((r) => user.roles.includes(r));
}
