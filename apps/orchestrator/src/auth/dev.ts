import type { UserProfile } from '@prowess/contracts';
import type { AuthContext, Authenticator } from './types.js';

/**
 * Local development authenticator. Selects one of a fixed set of fictitious
 * users via the `x-prowess-dev-user` header so role-based behaviour can be
 * exercised without an IdP. Configuration refuses this mode outside DEV.
 */
export const DEV_USERS: readonly UserProfile[] = [
  { id: 'alex.morgan@prowess.example', displayName: 'Alex Morgan', email: 'alex.morgan@prowess.example', tenantId: 'prowess-dev', roles: ['AI_USER', 'AI_POWER_USER'] },
  { id: 'jordan.lee@prowess.example', displayName: 'Jordan Lee', email: 'jordan.lee@prowess.example', tenantId: 'prowess-dev', roles: ['AI_USER'] },
  { id: 'sam.rivera@prowess.example', displayName: 'Sam Rivera', email: 'sam.rivera@prowess.example', tenantId: 'prowess-dev', roles: ['AI_USER', 'AI_POWER_USER', 'AI_ADMIN'] },
  { id: 'casey.kim@prowess.example', displayName: 'Casey Kim', email: 'casey.kim@prowess.example', tenantId: 'prowess-dev', roles: ['AI_AUDITOR'] },
];

export class DevAuthenticator implements Authenticator {
  readonly mode = 'dev' as const;

  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null> {
    const requested = headers['x-prowess-dev-user'];
    const id = Array.isArray(requested) ? requested[0] : requested;
    const user = DEV_USERS.find((u) => u.id === id) ?? DEV_USERS[0]!;
    return { user: structuredClone(user) };
  }
}
