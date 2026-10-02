# Local development

## Requirements

Node.js 22+ and npm 10+. Nothing else. SAP and model providers are mocked by default.

```sh
npm ci
npm run dev
```

| Service | URL |
| --- | --- |
| Web (Next.js dev server, proxies `/api`) | http://localhost:3000 |
| Orchestrator API | http://localhost:4000/api/v1 |
| SAP MCP | http://localhost:4100/mcp |
| Metrics | http://localhost:4000/metrics, http://localhost:4100/metrics |

`scripts/dev.mjs` generates an ephemeral `SERVICE_ASSERTION_SECRET` per run and loads `.env` if it exists.

## Using real model providers locally

```sh
cp .env.example .env
# fill in e.g. AICORE_SERVICE_KEY + AICORE_ORCHESTRATION_DEPLOYMENT_ID, or AZURE_AI_* …
echo "DEFAULT_LLM_PROVIDER=sap-ai-core" >> .env
npm run dev
```

The startup log line `orchestrator.config` lists which providers are enabled. Keep `LLM_ALLOW_MOCK=true` to fall back
to the mock model when a tier has no configured provider.

## Using a real S/4HANA locally

Set `SAP_MODE=odata`. The SAP Cloud SDK then reads destinations from a `destinations` environment variable, for example:

```sh
destinations='[{"name":"S4HANA","url":"https://my-s4.example.com","username":"…","password":"…"}]'
SAP_ALLOW_TECHNICAL_USER=true   # local only — there is no user token in dev auth mode
```

## PostgreSQL locally

```sh
docker compose up -d postgres
echo 'PERSISTENCE=postgres' >> .env
echo 'DATABASE_URL=postgres://prowess:prowess@localhost:5432/prowess?sslmode=disable' >> .env
```

Migrations run automatically at startup, guarded by an advisory lock.

## Malware scanning locally

```sh
docker compose up -d clamav     # takes a few minutes to load signatures
echo -e 'MALWARE_SCANNER=clamav\nCLAMAV_HOST=localhost' >> .env
```

## Tests

```sh
npm test            # vitest: packages + apps (LLM adapters, MCP contract, API/authz, components)
npm run test:e2e    # Playwright, starts the stack itself (or reuses a running one)
npm run lint && npm run typecheck
```

The E2E suite changes mock SAP state (it releases the demo invoice). Restart `npm run dev` before re-running it
against a reused server.

## Conventions

- Strict TypeScript everywhere. Shared types live in `@prowess/contracts`.
- Business logic lives in services, never in route handlers.
- Components use design tokens (`bg-surface`, `text-ink`, `text-brand`, …), never raw colors.
- Any new user-visible string from the backend must be safe to show (no stack traces, no internal IDs other than the reference).
