# AI platform roadmap — design

Status: **draft for review** · nothing here is built yet.

This closes the gaps found when comparing Prowess AI with a typical enterprise agent stack. The agent loop,
MCP tools, model routing, identity propagation and confirmation-before-write are already production grade
and are not changed. Every addition follows the existing rules in [architecture.md](architecture.md):
ports with a mock and a real adapter, configuration over code, tool and document content is untrusted,
SAP authorization stays authoritative.

## Gaps and order

| Phase | Item | Concepts | Why this order |
| --- | --- | --- | --- |
| 1 | [Evals](#1-evals) | LLM evals, LLMOps | Every later change (models, prompts, retrieval) needs a way to show it did not get worse |
| 1 | [Tracing](#2-tracing) | LLM observability | Cheap; needed to debug eval failures and production turns |
| 2 | [Structured output](#3-structured-output) | Structured outputs | Small; summary, workflow steps and memory extraction depend on it |
| 2 | [Retrieval](#4-retrieval) | Embeddings, vector DB, semantic/hybrid search, chunking, RAG | Start with Fiori guides and admin documents, which carry no per-user SAP data |
| 3 | [Past cases](#43-sources) | RAG over own history | Needs the authorization decision below first |
| 3 | [Data protection](#5-data-protection) | Guardrails | Before HR or invoice data reaches a non-private provider in production |
| 4 | [Long-term memory](#6-long-term-memory) | Agent memory | Needs a retention and consent decision from data protection |

Not planned: LangChain, LangGraph (the own loop and `WorkflowService` cover them), a reranker
(add only if eval scores for retrieval show it is needed), a separate vector database (PostgreSQL with
pgvector is enough at this scale).

```mermaid
flowchart LR
  CHAT[ChatService] --> ROUTER[ModelRouter]
  CHAT --> MCPC[McpGateway]
  CHAT -. new .-> KS[knowledge_search tool]
  KS -. new .-> KNOW[KnowledgeService]
  KNOW -. new .-> EMB[EmbeddingProvider<br/>AI Core]
  KNOW -. new .-> KSTORE[(KnowledgeStore<br/>pgvector + full text)]
  ROUTER -. new .-> GUARD[Outbound guard<br/>PII redaction]
  CHAT -. new .-> SPANS[Spans → OTLP]
  EVAL[Eval runner<br/>CI] -. new .-> CHAT
```

---

## 1. Evals

**Goal:** a repeatable score per agent, run in CI and before any model, tier or prompt change.

**Where:** `tests/evals/` (cases and runner), reusing `apps/orchestrator/test/harness.ts` and the mock SAP,
SuccessFactors and Outlook gateways, so cases are deterministic on the data side.

**Case format** (`tests/evals/cases/<agent>.json`; built, see `tests/evals/checks.ts`):

```json
{
  "id": "fico-ap-aging",
  "agent": "fico",
  "user": "alex",
  "tags": ["safety"],
  "turns": [{
    "ask": "Show the payables aging for company code 1030.",
    "expect": {
      "tools": ["ap_getAging"],
      "notTools": ["gl_postJournalEntry"],
      "args": { "ap_getAging": { "companyCode": "1030" } },
      "confirmation": false,
      "maxModelCalls": 3,
      "answer": { "includes": ["SAR"], "excludes": ["has been posted"] }
    }
  }]
}
```

`user` is a dev user key from the test harness, so roles and tool access are realistic. `tools` passes only when
the tool was called and succeeded. `notTools: ["*"]` means no tool at all. A `judge` rubric is added with step 1.2.

**Scores**, per case and summed per agent:

| Check | How | Deterministic |
| --- | --- | --- |
| Tool choice | Expected tools called, forbidden tools not called | yes |
| Arguments | Partial match on the listed arguments | yes |
| Rounds | Rounds used ≤ `LLM_MAX_TOOL_ROUNDS` | yes |
| Answer facts | `includes` / `excludes` strings | yes |
| Answer quality | LLM judge with the case's rubric, pass/fail plus reason, judged by a fixed tier | no |
| Safety | A shared set of injection and permission cases (document says "ignore your rules", user asks to skip confirmation) | yes |

**Running:** `npm run eval -- --tier standard [--agent ap]`. The tier picks the real provider, so the
same cases compare models. Output is `test-results/evals/<date>-<tier>.json` plus a short table.
CI runs the deterministic checks on every PR with the `mock` provider (fast, free) and the full run,
including the judge, nightly and on demand against AI Core.

**Baseline:** the last accepted report is committed as `tests/evals/baseline/<tier>.json`. The run fails
when a deterministic score drops, or the judge pass rate drops by more than an agreed margin (start at 5 points).

**Prompt versions (LLMOps):** each report records a `promptVersion`, a short hash of the agent's
instructions and the system prompt template, so a score change can be tied to the prompt change behind it.
The same hash goes on traces and `usage_events`.

## 2. Tracing

**Goal:** one trace per chat turn showing every model call and tool call, with timings, tokens and cost.

`packages/observability` already keeps W3C `traceId`/`spanId` in `RequestContext`. Add a `span(name, attrs, fn)`
helper that uses `@opentelemetry/api`, and start the OTel SDK with an OTLP exporter only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (no exporter, no cost, same as today).

| Span | Parent | Attributes (OTel GenAI conventions) |
| --- | --- | --- |
| `chat.turn` | HTTP request | agent, tier, `prompt.version`, handoffs, status |
| `gen_ai.chat` | `chat.turn` | `gen_ai.system` (provider), `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `…output_tokens`, cached tokens, finish reason, fallback attempt |
| `tool.call` | `chat.turn` | tool name, risk, status, duration, result size, shortened or not |
| `knowledge.search` | `tool.call` | source types, hits, top score |

Prompt and completion text are **not** recorded by default. `OTEL_CAPTURE_CONTENT=true` turns it on for
dev and test spaces only; the orchestrator refuses it when the environment is production.

Back end: SAP Cloud Logging accepts OTLP; Langfuse or another OTLP back end works the same way.

## 3. Structured output

**Goal:** model output that code consumes is checked against a schema, with one repair attempt.

- `LLMRequest` gets `responseFormat?: { name: string; schema: JSONSchema }`.
- Each provider maps it to its native feature: OpenAI-compatible, Azure and AI Core (foundation) use
  `response_format: json_schema`; AI Core orchestration uses its `response_format` template field; Vertex uses
  `responseSchema`; Bedrock uses a forced single tool call. The mock provider returns a schema-valid sample.
- A helper `completeStructured(router, tier, request, zodSchema)` builds the JSON schema with
  `z.toJSONSchema` (zod 4 is already a dependency), validates the reply, and on failure sends one follow-up
  with the validation errors. A second failure is an error, never a guess.

First users: the rolling conversation summary (`updateSummary`), workflow steps that read model output,
and memory extraction (phase 4). Invoice extraction stays on SAP Document AI (`DocumentAiExtractor`) and is unchanged.

## 4. Retrieval

### 4.1 Components

| Part | Where | Notes |
| --- | --- | --- |
| `EmbeddingProvider` port | `packages/llm` | `embed(texts: string[]): Promise<number[][]>`; adapters: AI Core (`/inference/deployments/{id}/embeddings`), mock (hash-based vectors so tests are deterministic) |
| `KnowledgeStore` port | `orchestrator/src/knowledge` | `upsert(chunks)`, `remove(source)`, `search(query, scope, k)`; adapters: memory, PostgreSQL |
| `KnowledgeService` | `orchestrator/src/knowledge` | chunking, embedding, ingestion, search; the only caller of both ports |
| `knowledge_search` tool | orchestrator-native, like `agent_handoff` | offered to agents whose catalog entry lists knowledge sources |

### 4.2 Storage (PostgreSQL migration)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE knowledge_chunks (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,          -- fiori_guide | document | case | memory
  source_id       TEXT NOT NULL,
  agent_ids       TEXT[] NOT NULL,        -- which agents may search it
  required_roles  TEXT[] NOT NULL DEFAULT '{}',
  owner_user_id   TEXT,                   -- set for user-scoped sources (cases, memory)
  locale          TEXT NOT NULL DEFAULT 'en',
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content)) STORED,
  embedding       VECTOR(1536) NOT NULL,
  embedding_model TEXT NOT NULL,          -- re-embed when the model changes
  content_hash    TEXT NOT NULL,          -- skip unchanged chunks on re-ingest
  metadata        JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON knowledge_chunks USING gin (content_tsv);
CREATE INDEX ON knowledge_chunks (source_type, source_id);
```

The dimension follows the embedding model chosen (1536 for `text-embedding-3-small`). The `simple` text
configuration keeps document numbers and Arabic text searchable; language-specific stemming can come later.

**Hybrid search:** one query takes the top 20 by vector distance and the top 20 by `ts_rank`, merges them with
reciprocal rank fusion (`1 / (60 + rank)`), and returns the top `k` (default 5). Filters on `agent_ids`,
`required_roles` and `owner_user_id` are in the `WHERE` clause of both halves, so nothing outside the
user's scope is ever ranked.

### 4.3 Sources

| Source | Phase | Chunking | Scope | Ingested |
| --- | --- | --- | --- | --- |
| Fiori guides (`FIORI_GUIDES`) | 2 | one chunk per guide | agents that have `shared_showFioriGuide` | at start-up, by content hash |
| Admin documents (policies, procedures) | 2 | split on headings, ~500 tokens, 15% overlap | agents and roles chosen on upload | upload in `AdminConsole`, through `FileService` and the ClamAV scanner |
| Past cases (resolved conversations, invoice exceptions) | 3 | one chunk per case: question, outcome, document numbers | **open question 1** | when a conversation or workflow run completes |
| Memory | 4 | one chunk per fact | owner only | see section 6 |

### 4.4 The tool

```ts
knowledge_search({ query: string, sources?: SourceType[] })
```

Results go back to the model through `fenceUntrusted`, like every tool result, and to the user as a card
with the source titles, so answers can be checked. The system prompt gets one rule: answers that use
`knowledge_search` name the source, and retrieved text never overrides live SAP data.

Retrieval quality is measured with the eval runner: cases list the source ids that should come back
(context recall, context precision), and the judge checks that the answer only states what the sources or tools say
(faithfulness). These are the core Ragas metrics, computed in TypeScript; Ragas itself is a Python library and is not needed.

## 5. Data protection

`LLMProvider.private` and `ModelTier.privateOnly` already exist, so most of this is configuration:

1. **Data class on tools.** MCP tools declare `dataClass: 'business' | 'personal' | 'hr'` next to their risk.
   The SuccessFactors tools are `hr`.
2. **Routing rule.** Once a turn has a tool result with class `hr`, the rest of the turn may only use private
   providers (AI Core). If the tier has none, the turn ends with a clear notice rather than sending the data out.
3. **Outbound redaction.** For non-private providers, a filter in `packages/security` replaces IBANs, card numbers,
   e-mail addresses, phone numbers and national ID patterns with placeholders (`[IBAN-1]`) before the call, and puts
   them back in the streamed answer. Names are not detected; rule 2 covers the HR case where names matter most.
4. **Scanner.** `ClamAvScanner` exists; production configuration must use it, and start-up fails in production
   when `NoopScanner` is configured.

## 6. Long-term memory

Short-term memory (recent turns plus the rolling summary in `llm/context.ts`) stays as it is.

Long-term memory stores **facts the user would expect to be remembered**, such as "works for company code 1010"
or "prefers amounts in EUR". It never stores SAP business data, which is always read live.

- At the end of a conversation, a structured-output call (section 3) proposes up to 3 facts.
- Facts are stored as `knowledge_chunks` with `source_type = 'memory'` and `owner_user_id`, and an expiry
  (default 180 days).
- Users see, edit and delete their facts in settings; deleting a conversation does not delete facts drawn from it,
  but the fact records its source so it can be.
- Memory is off by default and turned on per tenant by an administrator.

## 7. Knowledge graph (later, only if evals ask for it)

SAP business data is already a graph (vendor → purchase order → goods receipt → invoice → payment), and agents
walk it live through MCP tools, where SAP checks each step against the user's authorizations. A copy of that graph
outside SAP would go stale and bypass those checks, so **no graph of S/4 or SuccessFactors data is built**.

A graph helps only for links that SAP does not hold: past case ↔ vendor ↔ document numbers ↔ policy that applied,
and policy ↔ company code or process it covers. Answering "why was this vendor's last invoice blocked, and which rule
applied?" needs those links (multi-hop); plain vector search returns related chunks but not how they connect.

- **Trigger:** add it only when eval cases with multi-hop questions fail with vector search alone.
- **Storage:** one `knowledge_edges (from_id, relation, to_id, source_chunk_id)` table next to `knowledge_chunks`.
  Edges are extracted at ingestion with structured output (section 3) against a fixed list of entity and relation types.
  Traversal is a recursive CTE, at most 2 hops, with the same scope filters as search. No graph database, no new service.
- **Use:** `knowledge_search` expands its top hits by one hop and returns the linked entities with the chunks.
- **Not chosen:** HANA Cloud knowledge graph engine (RDF/SPARQL; only if the tenant runs HANA Cloud and needs a
  shared ontology), Apache AGE (not confirmed on BTP PostgreSQL), Neo4j (another service to run and secure for one table's worth of edges).
  SAP Knowledge Graph (Business Data Cloud) is the strategic option for semantics over SAP data; revisit when a tenant has BDC.

## Action plan

Estimates are developer-days for one developer who knows this codebase. Weeks assume one developer; two developers
can run the evals and tracing tracks, and later the structured output and retrieval tracks, side by side.

### Week 0 — decisions and checks (before any code)

| # | Action | Owner | Done when |
| --- | --- | --- | --- |
| 0.1 | Turn on `vector` in a free-tier BTP PostgreSQL 16, create an HNSW index, load 10k mock chunks, record `pg_total_relation_size` | Developer / BTP admin | Extension works, KB per chunk measured |
| 0.2 | Deploy the embedding model in AI Core (resource group of `prowess-aicore`), call it once | BTP admin | Deployment id known |
| 0.3 | Decide open question 1 (past cases), 4 (embedding model, dimensions), 5 (eval case count, baseline sign-off) | Product owner + architect | Written in this doc |
| 0.4 | Start the data protection review for memory (question 6) | Product owner → DPO | Review requested (runs in parallel) |

### Phase 1 — measure (weeks 1–3, ~16 days)

| # | Action | Where | Days |
| --- | --- | --- | --- |
| 1.1 | Eval case format, loader and runner, deterministic checks, JSON report | `tests/evals/`, `apps/orchestrator/test/harness.ts` | 5 |
| 1.2 | LLM judge with a fixed tier | `tests/evals/` | 1 |
| 1.3 | First cases: 20 each for `fico`, `mm`, `sd`, `hcm`, incl. 5 safety cases each | `tests/evals/cases/` | 4 |
| 1.4 | `npm run eval`; CI job (mock provider, every PR); nightly job (AI Core) | `package.json`, CI config | 1 |
| 1.5 | First run on AI Core, review failures, commit baseline | `tests/evals/baseline/` | 1 |
| 1.6 | `promptVersion` hash, recorded in reports and `usage_events` | `llm/context.ts`, persistence | 0.5 |
| 1.7 | `span()` helper, OTel SDK started only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | `packages/observability` | 2 |
| 1.8 | Spans for turn, model call, tool call; content capture refused in production | `chat-service.ts`, `packages/llm/router.ts` | 1.5 |

**Exit:** a baseline score per agent, and one production-like turn visible as a trace in SAP Cloud Logging.

### Phase 2 — ground (weeks 4–7, ~21 days)

| # | Action | Where | Days |
| --- | --- | --- | --- |
| 2.1 | `responseFormat` on `LLMRequest`, mapped in all six providers, with tests | `packages/llm` | 4 |
| 2.2 | `completeStructured` with zod validation and one repair; move `updateSummary` onto it | `packages/llm`, `llm/context.ts` | 2 |
| 2.3 | `EmbeddingProvider` port, AI Core and mock adapters | `packages/llm` | 2 |
| 2.4 | Migration for `knowledge_chunks`; `KnowledgeStore` with PostgreSQL (hybrid search) and memory adapters | `orchestrator/src/knowledge`, `persistence/postgres.ts` | 3 |
| 2.5 | `KnowledgeService`: chunking, content-hash re-ingest, scope filters | `orchestrator/src/knowledge` | 3 |
| 2.6 | `knowledge_search` tool, source card in the UI, system prompt rule | `chat-service.ts`, `apps/web`, `@prowess/contracts` | 2 |
| 2.7 | Ingest Fiori guides at start-up | `orchestrator/src/knowledge` | 1 |
| 2.8 | Admin document upload (through `FileService` and ClamAV) with agent and role scope | `AdminConsole`, `api/routes.ts` | 3 |
| 2.9 | Retrieval eval cases (expected sources, faithfulness) for 2 agents | `tests/evals/cases/` | 1 |

**Exit:** retrieval cases pass; overall eval scores no lower than the baseline.

### Phase 3 — extend and protect (weeks 8–10, ~12 days)

| # | Action | Where | Days |
| --- | --- | --- | --- |
| 3.1 | Fail start-up in production when `NoopScanner` is configured | `files/scanner.ts`, `config/env.ts` | 0.5 |
| 3.2 | `dataClass` on MCP tools; SuccessFactors tools marked `hr` | `apps/sap-mcp/src/tools`, `@prowess/contracts` | 2 |
| 3.3 | Private-provider-only rule after an `hr` result; notice when the tier has none | `chat-service.ts`, `packages/llm/router.ts` | 2 |
| 3.4 | Outbound redaction and restore for non-private providers | `packages/security` | 3 |
| 3.5 | Past-case ingestion on conversation and workflow completion, per the week-0 decision | `orchestrator/src/knowledge`, `workflow-service.ts` | 3 |
| 3.6 | Eval cases for past cases and for HR routing | `tests/evals/cases/` | 1.5 |

**Exit:** no HR data reaches a non-private provider in the safety evals; past-case cases pass.

### Phase 4 — remember (after DPO sign-off, ~8 days)

| # | Action | Days |
| --- | --- | --- |
| 4.1 | Fact extraction at conversation end (structured output), storage with expiry, tenant switch (off by default) | 5 |
| 4.2 | "What Prowess remembers" in settings: view, edit, delete | 3 |

### Conditional — knowledge graph (~5 days)

Start only if multi-hop eval cases fail in phase 2 or 3: `knowledge_edges` table, edge extraction at ingestion,
one-hop expansion in `knowledge_search`, eval cases.

### Total

About 57 developer-days for phases 1 to 4, roughly 12 weeks for one developer or 7 weeks for two, plus
5 days if the knowledge graph is needed. Not included: BTP and AI Core provisioning time, DPO review time,
and running costs (nightly eval runs on AI Core; PostgreSQL growth per the sizing in question 2).

## Open questions

1. **Who may see past cases?** A resolved case contains SAP data that was visible to the user who worked it.
   Options: owner only (safe, less useful); same agent and roles (useful, but can show data from company codes
   another user may not access); store only the outcome and document numbers, and let the agent re-read the
   details live through SAP, so SAP checks the permission. The third is recommended.
2. **HANA Cloud.** `architecture.md` lists HANA Cloud as an alternative store, but only PostgreSQL and memory
   adapters exist. Is a HANA vector adapter needed, or is PostgreSQL the only production store?
   Sizing (HANA Cloud CU estimator, Azure, 2026-10-29): about 16 KB of memory per 1536-dimension chunk, including
   text and indexes (an assumption to check in a pilot). Up to ~500k chunks fits the smallest instance
   (16 GB memory, 1 vCPU, 454 CU/month); ~1M chunks needs 32 GB (≈ 884 CU); ~2.5M needs 80 GB (2,175 CU).
   Only worth it when the tenant already runs HANA Cloud; otherwise pgvector in the existing PostgreSQL adds no instance.
   PostgreSQL on BTP (BTPEA list price, 2026-10-29: Standard €70 per 2 GB memory, Premium €102 per 4 GB, storage €6.50
   per 5 GB, HA storage €9 per 5 GB) needs only the HNSW index in memory (~6.5 KB per chunk), not the text:
   ~500k chunks ≈ €230/month for the whole instance, ~1M ≈ €345, ~2.5M ≈ €690, single node.
3. **pgvector on BTP.** Confirm the PostgreSQL service plan in the target subaccount allows the `vector` extension.
4. **Embedding model.** `text-embedding-3-small` on AI Core, or an SAP-hosted model for tenants that require
   data to stay in the landscape.
5. **Eval budget.** How many cases per agent before the first baseline (suggested: 20, including 5 safety cases),
   and who signs off on a baseline change.
6. **Memory consent.** Data protection sign-off on retention, consent and the right to see and delete.
