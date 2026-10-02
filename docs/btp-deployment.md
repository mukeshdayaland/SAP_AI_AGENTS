# SAP BTP deployment

## Services

| Instance | Service / plan | Used by | Why |
| --- | --- | --- | --- |
| `prowess-xsuaa` | `xsuaa` / `application` (from `infrastructure/btp/xs-security.json`) | web, orchestrator, MCP | Login, JWT validation, token exchange |
| `prowess-destination` | `destination` / `lite` | MCP | S/4HANA destination |
| `prowess-connectivity` | `connectivity` / `lite` | MCP | Cloud Connector tunnel (on-premise S/4) |
| `prowess-aicore` | `aicore` / `extended` (existing) | orchestrator | SAP AI Core inference |
| `prowess-postgres` | `postgresql-db` (existing) | orchestrator | Conversations, actions, usage |
| `prowess-auditlog` | `auditlog` / `oauth2` | orchestrator | Business audit trail |
| `prowess-logging` | `cloud-logging` / `standard` | all | Logs and metrics (OpenTelemetry-ready) |
| `prowess-secrets` | user-provided | orchestrator, MCP | Assertion secret and non-SAP provider credentials |

Nothing else is provisioned. Object storage isn't needed while uploads stay short-lived (see operations).

## One-time setup per space

```sh
# 1. SAP AI Core: create an orchestration deployment in your resource group and note its ID.
# 2. PostgreSQL: cf create-service postgresql-db <plan> prowess-postgres -c '{"engine_version":"16"}'
# 3. Secrets (never commit the JSON file):
cat > /tmp/prowess-secrets.json <<'JSON'
{
  "SERVICE_ASSERTION_SECRET": "<64 random hex chars>",
  "AICORE_ORCHESTRATION_DEPLOYMENT_ID": "<id>",
  "AZURE_AI_ENDPOINT": "https://<resource>.openai.azure.com",
  "AZURE_AI_AUTH": "client-secret",
  "AZURE_TENANT_ID": "…", "AZURE_CLIENT_ID": "…", "AZURE_CLIENT_SECRET": "…"
}
JSON
cf cups prowess-secrets -p /tmp/prowess-secrets.json && rm /tmp/prowess-secrets.json
# 4. Destination "S4HANA" in the subaccount (see sap-connectivity.md).
```

Values in `prowess-secrets` are merged into the environment at startup. Any variable from `.env.example` can be
supplied this way. For stricter setups, store them in SAP Credential Store and inject them in the same way.

## Build and deploy

```sh
npm ci
npx mbt build -p=cf -t dist-mta                  # runs `npm run build:cf`
cf deploy dist-mta/prowess-ai_0.1.0.mtar -e infrastructure/btp/dev.mtaext
```

`build:cf` bundles each Node service with esbuild into `apps/*/dist` (workspace packages inlined, third-party
dependencies listed in a generated `package.json`). It also assembles the approuter module, pinning the hashes of
Next.js inline scripts in the CSP.

Alternatively, use `cf push -f infrastructure/cloudfoundry/manifest.yml`. It gives the orchestrator and MCP internal
routes only (`apps.internal`) plus container-to-container network policies. This is recommended where possible:
only the approuter is publicly reachable.

## After deployment

1. Assign role collections (`Prowess_AI_User`, `…PowerUser`, `…Admin`, `…Auditor`) to IdP groups.
2. Check `https://<web-route>/api/readiness` (through the approuter): store, MCP and at least one provider must be healthy.
3. Open the admin console (**Administration → Overview**) to confirm the provider routing.

## Landscapes

`infrastructure/btp/{dev,qa,prod}.mtaext` set `PROWESS_ENV`, instance counts and log levels. Deploy each to its own
space with its own secrets and destinations. A QA deployment must never point at a PROD S/4HANA destination.
Configuration enforces that:

- `AUTH_MODE=dev`, the mock model and in-memory persistence are refused outside DEV,
- `SAP_MODE=mock` is refused in PROD,
- uploads outside DEV require a malware scanner.
