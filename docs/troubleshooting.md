# Troubleshooting

| Problem | Cause / fix |
| --- | --- |
| Orchestrator exits: `SERVICE_ASSERTION_SECRET must be at least 32 characters` | Set it (same value) for the orchestrator and MCP. `npm run dev` generates one automatically. |
| `AUTH_MODE=dev is only permitted when PROWESS_ENV=DEV` | Use `AUTH_MODE=xsuaa` with a bound xsuaa instance outside DEV. |
| `No LLM provider is configured` | Configure at least one provider, or keep `LLM_ALLOW_MOCK=true` in DEV. |
| Chat says *running with the offline mock model* | No real provider is enabled for the chosen tier. Check the `orchestrator.config` startup log. |
| A tier is missing from the model selector | The user lacks the tier's role, the agent doesn't list the tier, or no provider for it is configured. |
| `LLM_NOT_CONFIGURED` for *Private* | Private tiers only route to SAP AI Core (`privateOnly`). Configure AI Core. |
| SAP AI Core 404 on `/v2/completion` | Wrong `AICORE_ORCHESTRATION_DEPLOYMENT_ID` or resource group. The deployment must be `RUNNING`. |
| SAP AI Core 400 *model not found* | Model name in `models.json` isn't available in your region/hub. Check the generative AI hub model list. |
| Azure 401/403 | Missing role assignment (*Cognitive Services OpenAI User*), wrong scope, or a key for another resource. |
| Azure 404 | The deployment name in `models.json` doesn't exist. For `openai-deployments`, check `AZURE_AI_API_VERSION`. |
| Bedrock `AccessDeniedException` | Model access not granted in the Bedrock console, or the IAM policy lacks `bedrock:InvokeModelWithResponseStream`. |
| Bedrock `ValidationException` on tools | Some models don't support tool use in streaming. Pick a Converse tool-capable model. |
| Vertex 403 | Service account lacks *Vertex AI User*, or the API isn't enabled in the project. |
| Streaming stalls behind a proxy | Ensure no buffering proxy sits between browser and approuter. The approuter needs `INCOMING_CONNECTION_TIMEOUT ≥ 300000`. |
| `CSRF_CHECK_FAILED` | A client didn't send `X-Requested-With: prowess` on a mutating call. |
| `SAP_NOT_AUTHORIZED` in tool steps | The SAP user lacks authorization. This is intended behaviour and can't be overridden by Prowess roles. |
| `NOT_SUPPORTED` from OData gateway | The capability isn't wired to a standard API yet (G/L balance, search, notes). See `sap-connectivity.md`. |
| Upload rejected: *content does not match its type* | The file's bytes don't match its extension (for example a renamed file). |
| Upload fails with `SCAN_UNAVAILABLE` | ClamAV isn't reachable. Scanning fails closed. |
| E2E test fails on the second local run | Mock SAP state persists while the stack runs. Restart `npm run dev`. |
