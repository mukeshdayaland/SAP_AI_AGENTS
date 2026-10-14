# Authentication & authorization

## Production (BTP)

```mermaid
sequenceDiagram
  actor U as User
  participant AR as prowess-ai-web (approuter)
  participant IAS as SAP Cloud Identity Services
  participant IdP as Corporate IdP
  participant X as XSUAA
  participant O as Orchestrator
  participant M as SAP MCP
  participant D as Destination service
  participant S as S/4HANA
  U->>AR: GET /
  AR->>X: OAuth authorization code flow
  X->>IAS: federated login
  IAS->>IdP: SAML/OIDC SSO
  IdP-->>U: MFA / SSO session
  X-->>AR: user JWT (scopes = role collections)
  AR-->>U: session cookie (JWT never reaches the browser)
  U->>AR: POST /api/v1/chat
  AR->>O: forwardAuthToken: Authorization: Bearer <user JWT>
  O->>O: @sap/xssec validates signature/audience/expiry, maps scopes → roles
  O->>M: principal assertion + user JWT (hash-bound)
  M->>D: destination lookup with user JWT (token exchange)
  D-->>M: SAML/OAuth assertion for the user (principal propagation)
  M->>S: OData as the user → SAP authorization check
```

- The browser holds only the approuter session cookie. Service credentials and JWTs stay server-side.
- `AUTH_MODE=xsuaa` requires a bound `xsuaa` instance. Configuration refuses `AUTH_MODE=dev` outside `PROWESS_ENV=DEV`.
- Users with no Prowess scope are rejected (`SECURITY_DENIAL: no_roles`).

## Application roles

Defined in `infrastructure/btp/xs-security.json` and assigned through role collections:

| Role collection | Scopes | Grants |
| --- | --- | --- |
| `Prowess_AI_User` | `AI_USER` | Standard tier, all agents requiring `AI_USER` |
| `Prowess_AI_PowerUser` | `AI_USER`, `AI_POWER_USER` | + Advanced tier, technical execution details (provider/model/tokens) |
| `Prowess_AI_Admin` | `AI_USER`, `AI_ADMIN` | + administration console |
| `Prowess_AI_Auditor` | `AI_AUDITOR` | audit view only (no chat) |
| `Prowess_AI_HRUser` | `AI_USER`, `AI_HR_USER` | + the HCM (SuccessFactors) agent |

**These roles never grant SAP authorization.** An `AI_USER` who opens the FI-AP agent still sees only the invoices
their SAP user may display, and can release a payment block only if SAP authorizes them (for example
`M_RECH_WRK`, transaction MRBR). The mock backend simulates this: *Jordan Lee* is refused the release by SAP.

## Authorization layers

1. **Route**: approuter scopes on `/api` and `/admin`.
2. **Feature**: orchestrator checks the agent's `requiredRoles`, the tier's `requiredRoles`, and admin/audit roles.
3. **Tool**: the agent's `allowedTools`. Tools outside the list are never offered and are refused if requested.
4. **Action**: human confirmation plus a signed, argument-bound, single-use confirmation for every write.
5. **SAP**: S/4HANA authorization objects, evaluated for the propagated user. This is the final authority.

## Local development

`AUTH_MODE=dev` selects one of four fictitious users with the `x-prowess-dev-user` header. The UI sets it from
**Settings → Development identity**.

| User | Roles | Mock SAP authorizations |
| --- | --- | --- |
| Alex Morgan | AI_USER, AI_POWER_USER, AI_HR_USER | CC 1000/2000, may release invoices |
| Jordan Lee | AI_USER | CC 1000/2000, may **not** release invoices |
| Sam Rivera | AI_USER, AI_POWER_USER, AI_ADMIN, AI_HR_USER | CC 1000/2000 |
| Casey Kim | AI_AUDITOR | none |

Invoice `5100099999` belongs to company code 3000, so every user gets an SAP authorization denial for it.

The mock SuccessFactors simulates role-based permissions too: everyone sees the directory, job history only for
oneself and one's own reporting line, and HR (*Sam Rivera*) sees everyone. *Alex Morgan* is refused the job history of
his manager, employee `100010`. *Jordan Lee* lacks `AI_HR_USER` and is not offered the HCM agent at all.
