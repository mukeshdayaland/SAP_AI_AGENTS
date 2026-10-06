# Hosting the web app on Cloudflare Pages

The web app can be served from Cloudflare Pages on a custom domain while the orchestrator and SAP MCP stay on SAP BTP
Cloud Foundry. `apps/edge` replaces the SAP approuter with a backend-for-frontend (BFF) on Pages Functions:

```
Browser ──► https://<custom-domain>  (Cloudflare Pages, project prowess-ai)
             ├─ static Next.js export (apps/web/out)
             └─ functions/_middleware.ts → src/bff.ts
                  /login, /callback   XSUAA authorization code + PKCE
                  /logout             clears the session, then XSUAA /logout.do
                  /api/*              proxied to the orchestrator with the user's bearer token
                  everything else     requires a session; /admin needs AI_ADMIN or AI_AUDITOR
                  │
                  ▼
           SAP BTP Cloud Foundry: prowess-ai-orchestrator ──► prowess-sap-mcp ──► SAP
```

- **No token in the browser.** XSUAA tokens are sealed with AES-256-GCM into HttpOnly, `Secure`, `SameSite=Lax`
  `__Host-` cookies on the custom domain. Access tokens are refreshed shortly before expiry; the session ends when the
  XSUAA refresh token expires (8 h).
- **No CORS.** The browser only calls its own origin. The BFF rejects cross-site `Origin` headers on `/api`, and the
  orchestrator's `x-requested-with` CSRF check still applies.
- **Same security headers as the approuter.** Pages' `_headers` file does not apply to responses that pass through
  Functions, so the BFF sets CSP, HSTS and the rest itself and pins each inline script by SHA-256 hash.

## Configuration

`apps/edge/wrangler.toml` holds the non-secret settings:

| Variable | Value |
| --- | --- |
| `ORCHESTRATOR_URL` | Orchestrator route on BTP |
| `XSUAA_URL` | `url` from a `prowess-xsuaa` service key |
| `XSUAA_CLIENT_ID` | `clientid` from the same key |

Secrets, set once per Pages project and never committed:

| Secret | Value |
| --- | --- |
| `XSUAA_CLIENT_SECRET` | `clientsecret` from the service key |
| `SESSION_SECRET` | ≥ 32 random characters; rotating it signs everyone out |

The XSUAA instance must allow the custom domain as a redirect target: add `https://<custom-domain>/**` to
`oauth2-configuration.redirect-uris` and run `cf update-service prowess-xsuaa -c <xs-security.json>`.

## Deploy

```bash
npx wrangler@4 login
npm run package -w @prowess/edge
npm run deploy -w @prowess/edge
```

Then attach the custom domain in the Cloudflare dashboard (Workers & Pages → prowess-ai → Custom domains). With the
zone on Cloudflare, DNS and the certificate are created automatically.

The BTP approuter (`prowess-ai-web`) keeps working in parallel and can be removed once the Cloudflare site is verified.
