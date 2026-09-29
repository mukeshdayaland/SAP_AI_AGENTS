# prowess-ai-web (approuter)

The SAP Application Router is the only public entry point:

- performs the OAuth login with XSUAA (corporate IdP via SAP Cloud Identity Services),
- serves the statically exported Next.js UI from `resources/`,
- forwards `/api/*` to the `prowess-orchestrator` destination with the user's JWT (`forwardAuthToken`),
- sets security headers (CSP, HSTS, …).

The deployable module is assembled into `dist/` by `npm run build:cf` (see `scripts/package-web.mjs`):
the Next.js static export plus `resources-static/`, and an `xs-app.json` whose Content-Security-Policy pins
the SHA-256 hashes of every inline script Next.js emitted (no `'unsafe-inline'` scripts).
