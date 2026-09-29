# LLM providers

All inference goes through one internal contract (`packages/llm/src/types.ts`):

```ts
interface LLMProvider {
  stream(request: LLMRequest): AsyncIterable<LLMChunk>; // text · tool_call · usage · finish
  complete(request: LLMRequest): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
}
```

Adapters translate that contract to each vendor's wire format, including **tool calling**, which MCP depends on.
Neither the UI nor the MCP layer knows which vendor served a request.

| Provider id | Adapter | API used | Auth options (strongest first) |
| --- | --- | --- | --- |
| `sap-ai-core` | `SapAiCoreProvider` | Orchestration v2 `…/v2/completion` (all generative AI hub models) or foundation-model `…/chat/completions` | OAuth2 client credentials from the `aicore` binding |
| `azure-ai-foundry` | `AzureAIFoundryProvider` | `/openai/v1/chat/completions`, classic deployments, or Model Inference API | Entra **workload identity** (federated token) · Entra client secret · API key (dev) |
| `aws-bedrock` | `AwsBedrockProvider` | Converse `…/model/{id}/converse-stream` (binary event stream) | **SigV4 with temporary STS credentials** · Bedrock API key (dev) |
| `gcp-vertex` | `GcpVertexProvider` | Gemini `…:streamGenerateContent?alt=sse` | **Workload Identity Federation** (+ SA impersonation) · service-account key · access token (dev) |
| `mock` | `MockProvider` | none (deterministic, offline) | none (DEV only) |

No vendor SDKs are used. The adapters use `fetch`, with local SigV4 signing, event-stream decoding and Google JWT
signing. This keeps the orchestrator small and gives uniform behaviour for timeouts, retries and telemetry.

## Resilience (all adapters)

- **Timeouts**: connect/headers timeout plus a stream **idle timeout** (`http.ts`).
- **Bounded retries** with exponential backoff and equal jitter. `Retry-After` is honoured on 429/503. Retries happen
  only before any response body is consumed.
- **Circuit breaker** per provider (opens after 5 consecutive failures, half-open after 30 s).
- **Normalized errors**: `ProviderError.kind` (`rate_limited`, `timeout`, `unavailable`, `auth`, `content_filter`, …)
  maps to user-safe `AppError`s. Upstream bodies are truncated and never include credentials.
- **Correlation**: `traceparent` and `x-correlation-id` are sent on every call; Azure also gets `x-ms-client-request-id`.
- **Usage telemetry**: token counts per provider/model (`prowess_llm_tokens_total`) plus per-user/agent records in the store.

## Model tiers and routing

`apps/orchestrator/config/models.json` maps business tiers to ordered targets:

```json
{ "id": "advanced", "label": "Advanced", "requiredRoles": ["AI_POWER_USER"], "fallback": true,
  "targets": [
    { "provider": "sap-ai-core",      "model": "anthropic--claude-4-sonnet" },
    { "provider": "aws-bedrock",      "model": "eu.anthropic.claude-sonnet-4-20250514-v1:0" },
    { "provider": "azure-ai-foundry", "model": "gpt-4.1" },
    { "provider": "gcp-vertex",       "model": "gemini-2.5-pro" } ] }
```

- Targets whose provider is not configured are skipped automatically.
- `DEFAULT_LLM_PROVIDER` moves that provider's targets to the front of every tier.
- **Fallback happens only when the tier allows it, the error is retryable, and nothing has been streamed yet.**
  A partially streamed answer is never silently replaced.
- `privateOnly: true` (the *Private* tier) restricts routing to providers flagged `private` (SAP AI Core) and
  **never falls back to public cloud**.
- Standard users see only tier labels. Power users and admins see the resolved provider and model in technical details.

## Configuration

### SAP AI Core

On BTP, bind an `aicore` instance (extended plan). Credentials are read from `VCAP_SERVICES`. Locally, set
`AICORE_SERVICE_KEY` (the service key JSON) or the individual `AICORE_*` fields.

| Variable | Meaning |
| --- | --- |
| `AICORE_MODE` | `orchestration` (recommended) or `foundation` |
| `AICORE_ORCHESTRATION_DEPLOYMENT_ID` | Deployment of scenario `orchestration` in your resource group |
| `AICORE_RESOURCE_GROUP` | AI Core resource group (default `default`) |
| `AICORE_MASKING` | `true` enables SAP Data Privacy Integration anonymization of names, emails and phone numbers |

In orchestration mode `model` in `models.json` is a hub model name (`gpt-4.1`, `anthropic--claude-4-sonnet`,
`gemini-2.5-pro`, …). In foundation mode it is the deployment ID. Orchestration templates treat `{{?x}}` as a
placeholder, so the adapter neutralizes that syntax in all untrusted text.

### Azure AI Foundry

`AZURE_AI_ENDPOINT` (for example `https://<resource>.openai.azure.com` or `https://<resource>.services.ai.azure.com`)
and `AZURE_AI_API_STYLE`. For production use **workload identity**: set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
`AZURE_FEDERATED_TOKEN_FILE`. The file holds an OIDC token from a trusted issuer (for example SAP Cloud Identity
Services) configured as a federated credential on the Entra app. There is then no long-lived secret. Grant the app
*Cognitive Services OpenAI User* (or *Azure AI User*) on the resource.

### AWS Bedrock

`AWS_BEDROCK_REGION` plus credentials. Prefer short-lived STS credentials (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) issued via IAM Roles Anywhere or OIDC federation. They are re-read on
every request, so rotation needs no restart. The IAM policy needs `bedrock:InvokeModelWithResponseStream` on the
model/inference-profile ARNs. Optional: `AWS_BEDROCK_GUARDRAIL_ID`/`VERSION` applies a Bedrock Guardrail.

### Google Vertex AI

`GCP_PROJECT_ID`, `GCP_LOCATION` (`europe-west3`, `us-central1`, `global`, …). For production use Workload Identity
Federation: `GCP_WIF_AUDIENCE` (`//iam.googleapis.com/projects/…/workloadIdentityPools/…/providers/…`),
`GCP_WIF_SUBJECT_TOKEN_FILE`, and optionally `GCP_WIF_SERVICE_ACCOUNT` to impersonate a service account that has
*Vertex AI User*.

## Adding a provider

1. Implement `LLMProvider` in `packages/llm/src/providers/<name>.ts`, emitting complete `tool_call` chunks.
2. Add the id to `PROVIDER_IDS` and a builder to `factory.ts`.
3. Add recorded-response tests like `test/providers.test.ts`.
4. Reference it in `models.json`.

## Verification status

Every adapter is covered by tests against recorded request/response formats, including the official AWS SigV4
test vector and event-stream CRC validation. They have **not** been run against live tenants in this repository.
Validate each configured provider in DEV with a real deployment before enabling it in QA/PROD.
