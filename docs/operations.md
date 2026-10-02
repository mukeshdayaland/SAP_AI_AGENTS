# Operations

## Health

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health` (orchestrator), `GET /health` (MCP) | Liveness: process is up (CF health check) |
| `GET /api/readiness` | Store reachable, MCP servers' health, provider health. 503 if the store or all providers are down |
| `GET /readiness` (MCP) | System ID, mock flag, tool count |

## Logs

Structured JSON on stdout, shipped by SAP Cloud Logging. Every record has `service`, `correlationId`, `requestId`,
`traceId`, `userId`, `tenantId`, and where relevant `agent`, `provider`, `durationMs` and `status`. Secret-like keys
are redacted, and prompt and content fields are omitted.

Audit events are separate records (`"kind":"audit"`) or go straight to the SAP Audit Log service when bound.

Users see a reference like `PRW-20260928-7A2F`. Search logs for it: the full correlation ID starts with the reference.

## Metrics (`/metrics`, Prometheus text format)

| Metric | Labels |
| --- | --- |
| `prowess_http_requests_total`, `prowess_http_request_duration_ms` | route, method, status |
| `prowess_llm_requests_total`, `prowess_llm_request_duration_ms` | provider, model, outcome |
| `prowess_llm_tokens_total` | provider, model, direction |
| `prowess_llm_provider_up` | provider |
| `prowess_tool_calls_total`, `prowess_tool_call_duration_ms` | tool, outcome, side |
| `prowess_sap_request_duration_ms` | system, method |
| `prowess_errors_total` | category, code |

W3C `traceparent` is propagated web → orchestrator → MCP → SAP/LLM. An OpenTelemetry collector can scrape `/metrics`
and correlate by trace ID.

## Retention

- Conversations: purged hourly when not updated for `CONVERSATION_RETENTION_DAYS` (default 90).
- Uploads: deleted after `UPLOAD_RETENTION_HOURS` (default 24). File bytes live on the instance's ephemeral disk,
  so an attachment is available only on the instance that received it and only for this window. For multi-instance
  retention beyond minutes, back `FileService` with SAP Object Store.
- Pending confirmations expire after `CONFIRMATION_TTL_SECONDS` (default 600).

## Cost controls

Per-user and per-agent daily token limits (`DAILY_TOKENS_PER_USER`, `DAILY_TOKENS_PER_AGENT`), request rate
(`RATE_LIMIT_PER_MINUTE`), concurrent streams (`MAX_CONCURRENT_STREAMS_PER_USER`), and per-tier max output/context in
`models.json`. Usage by day, provider, tier and agent is shown under **Administration → Usage**.

Rate limiting and stream counting are per instance. With N instances the effective limit is up to N×. Token quotas
use the shared store, so they are global.

## Runbook

| Symptom | Check |
| --- | --- |
| "The AI service is temporarily unavailable" | `prowess_llm_provider_up`, provider status page, circuit breaker logs (`llm.provider_failed`). Consider `DEFAULT_LLM_PROVIDER` to another healthy provider. |
| Tools unavailable status in chat | MCP health; `mcp.discovery_failed` logs; network policy / route between orchestrator and MCP |
| SAP denied access | Expected when the user lacks SAP authorization. Check SU53 for the propagated user. |
| Confirmation "already processed" | Double submit or another tab. The action runs at most once. |
