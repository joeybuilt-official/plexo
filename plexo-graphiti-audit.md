# Plexo Memory Layer — Graphiti Migration Audit (Phase 0)

> **DECISION ACTED 2026-05-12.** Operator approved the audit recommendation; Graphiti adoption shipped via ADRs 0010 + 0015 (FalkorDB rather than Kuzu as the underlying graph). Cutover live 2026-05-12. Audit content below is preserved as the read-only decision basis.

**Status:** Read-only audit. Recommendation only. Final go/no-go on operator.
**Date:** 2026-05-09
**Repo target:** `/home/dustin/dev/joeybuilt/plexo` (branch `main`)
**Subject:** Should Plexo's memory layer migrate to Graphiti (https://github.com/getzep/graphiti) as the underlying engine, with Plexo Core remaining the canonical interface?

---

## Section 1 — Current State (Plexo memory layer at HEAD)

### 1.1 File-level inventory

`packages/agent/src/memory/` (22 TypeScript files, post-SCL-removal):

| File | Purpose (one line) |
|---|---|
| `store.ts:125,247,314` | `embed()`, `storeMemory()`, `searchMemory()` — primary write + cache-aware read entry points |
| `query.ts:53` | `queryMemory()` — authoritative vector + keyword retrieval w/ Phase-1 filters (superseded, invalidated, confidence) |
| `write.ts:136` | `writeFact()` — atomic-fact write with LLM-driven conflict classifier (UPDATE / SCOPE / NONE) |
| `extract-worker.ts:39,98,121,130` | Fire-and-forget post-turn fact extractor; calls `embed()` + `graphMutate()` per fact |
| `graph-query.ts:67,140,213,238` | `graphMutate / graphExpand / getGraphMeta / triggerGraphExtract` — **just-shipped concept-graph layer (ADR 0009 Phase 2)** |
| `embeddings.ts:98` | Shared HTTP-accessible embedding façade w/ LRU (5-min TTL, 1024-entry cap) |
| `cluster-api.ts`, `cluster.ts` | Louvain/Leiden clustering → `memory_themes`, `memory_knn_edges` |
| `namespace.ts` | Per-agent slice (`default`, `agent-${id}`, `shared`) |
| `preferences.ts` | Workspace behavior preferences (tier strategy, eviction) |
| `conversation-bridge.ts:198,200` | Post-turn hook → `extractTurn()` |
| `corrections.ts` | User-initiated edits + contradiction flagging |
| `self-improvement.ts`, `prompt-improvement.ts` | Mistake-driven prompt patching |
| `instruction-detect.ts` | "Remember X" directive matcher |
| `scl.ts` | **MISLEADING NAME** — `is_scl` *theme-promotion* gate, NOT MindsetObject SCL. Reads `memory_theme_history`. |
| `knn.ts:56,67,90` | kNN edge refresh via HNSW → `memory_knn_edges` |
| `suggest.ts` | Link suggestion generation from kNN edges |
| `promote.ts` | Tier promotion (active → hot) on retrieval |
| `consolidation.ts:42` | Event-driven memory aging; consolidates 30d+ task entries into summaries |
| `streaming-touch.ts` | Post-store kNN edge update |
| `ab-variants.ts` | A/B variant tracking for prompt experiments |

`apps/api/src/routes/`:

| File | Auth | Surface |
|---|---|---|
| `memory.ts:1` | `requireWorkspaceMember` | GET/POST/PUT/DELETE entries, search, preferences, clustering — workspace-gated |
| `graph.ts:1` (just shipped) | `requireServiceKey` | `/api/v1/graph/{mutate,expand,meta,extract/trigger}` |
| `memory-pax.ts:47` | `requireServiceKey` | `/memory/embeddings`, `/memory/cluster/{compute,label}` |

Schema (`packages/db/src/schema.ts`): 8 memory-related tables — `memory_entries`, `memory_embeddings`, `memory_themes`, `memory_knn_edges`, `memory_theme_runs`, `concept_nodes`, `concept_edges`, `concept_membership`.

Plus one zombie SCL leftover: `scl_concept_graphs` table at `schema.ts:1680-1693` with active consumers in `apps/api/src/lib/embeddings-reembed.ts:255-265,349-353` and `apps/api/src/routes/training-data.ts`. **Pending cleanup decision** (SCL-removal Phase 4 column-drop is gated).

### 1.2 Write path

```
sibling-app SDK call
   → Plexo Core HTTP (POST /api/v1/memory/entries)
   → apps/api/src/routes/memory.ts:166
   → packages/agent/src/memory/store.ts:247  (storeMemory)
   → INSERT INTO memory_entries (… embedding=NULL initially …)
   → embed()  (sync for pattern/note; fire-and-forget for others)
   → UPDATE memory_entries SET embedding = $vec::vector
   → streamingTouchAfterStore()  (refresh kNN edges, non-blocking)
   → Redis: invalidateSearchCache(workspaceId)
```

Async fact-extraction (chat surfaces only):
```
chat.ts:1095 → conversation-bridge.ts:200 → extract-worker.ts:39 (fire-and-forget)
  → LLM extract (0–3 facts per turn)
  → per fact: INSERT memory_entries + embed + graphMutate (concept link)
```

Conflict-resolved structured writes:
```
write.ts:136 → predicate lookup → LLM classifier (UPDATE | SCOPE | NONE)
  → on UPDATE: INSERT new fact + UPDATE old SET invalid_at=NOW(), superseded_by=$newId
```

Concept graph mutation (ADR 0009, just shipped):
```
graph-query.ts:67 → per concept: embed(label) → INSERT concept_nodes ON CONFLICT (workspace_id, label)
  → INSERT concept_membership
  → INSERT concept_edges (cosine ≥ 0.85, capped 5/new node)
```

### 1.3 Read path

`queryMemory()` at `packages/agent/src/memory/query.ts:53` is the authoritative entry point. Modes: `vector` (default), `keyword` (trigram/ILIKE), `hybrid` (UNION).

Vector mode SQL (`query.ts:149-160`):
```sql
SELECT … 1 - (embedding <=> $vec::vector) AS similarity
FROM memory_entries
WHERE workspace_id = $ws::uuid
  AND tier != 'cold'
  AND superseded_by IS NULL
  AND (invalid_at IS NULL OR invalid_at > NOW())
  AND confidence >= $minConfidence
  AND namespace = ANY($ns::text[])
  [AND (user_id = $u::uuid OR user_id IS NULL)]
ORDER BY
  CASE tier WHEN 'hot' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC,
  embedding <=> $vec::vector ASC
LIMIT $limit
```

Caller sites:
- `packages/agent/src/executor/index.ts:984` — planner prior-context lookup
- `apps/api/src/routes/chat.ts:617,689` — proactive recall + system-prompt block injection (`=== RELEVANT MEMORY ===`)
- Cold-tier excluded unless explicitly requested.

### 1.4 Embedding pipeline

`packages/agent/src/memory/store.ts:125`:
```ts
export async function embed(text: string, workspaceId: string, aiSettings?: WorkspaceAISettings): Promise<number[] | null>
```

Adapter resolution order:
1. Workspace `aiSettings.embedding.provider` (OpenAI / Ollama / local Xenova)
2. ENV (`OPENAI_API_KEY` → `text-embedding-3-small` @ 1536-dim)
3. Xenova local (default, 384-dim)
4. `EMBEDDINGS_URL` gateway

Per-provider circuit breaker (FUN-031): 2 consecutive failures → disable 15 min; immediate trip on 401/403.

**Dimension inconsistency:**
- `memory_entries.embedding` — added via raw SQL; comments mention vector(1536) AND vector(384) at different points (`schema.ts:666,722`)
- `memory_embeddings.embedding vector(384)` — separate decoupled table (HNSW index target)
- `concept_nodes.embedding vector(384)` — just-shipped (ADR 0009 Phase 2)

Operator's locked-decision context says **256-dim Matryoshka-truncated** going forward. Current code does NOT enforce 256 anywhere. Flag.

### 1.5 Vector index

`packages/db/drizzle/0102_memory_rebuild_phase1.sql:44-46`:
```sql
CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_hnsw_idx"
  ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

Concept-nodes secondary HNSW (`0118_concept_graph_phase_1.sql:36-37`): same params (m=16, ef_construction=64 inherited from pgvector defaults), `vector_cosine_ops`.

### 1.6 Supersession

Write side (`write.ts:206-213`):
```sql
UPDATE memory_entries
SET invalid_at = NOW(), superseded_by = $newId::uuid
WHERE id = $oldId::uuid
```

Read filter (`query.ts:75-76`): `superseded_by IS NULL AND (invalid_at IS NULL OR invalid_at > NOW())`.

`memory_entries.is_anchored boolean` (`schema.ts:700`) — flag for **immune-to-supersession** semantics. Honored by write-side `writeFact()` conflict classifier. **No background auto-supersession worker** — only write-time + manual.

### 1.7 Provenance per fact

`memory_entries` columns (`schema.ts:653-700`): `id`, `workspace_id`, `type`, `content`, `shorthand`, `metadata jsonb`, `tier`, `namespace`, `user_id`, `fact_type`, `subject`, `predicate`, `object`, `domain`, `app_id`, `source_text`, `source`, `superseded_by`, `valid_from`, `invalid_at`, `confidence`, `is_anchored`, `retrieval_count`, `last_retrieved_at`. Triple-aware (`subject/predicate/object`), source-aware (`source`, `source_text`), tenant + user + app scoped.

### 1.8 Access control

`schema.ts:4` comment: **SEC-028 — no Postgres RLS; workspace isolation enforced at app layer**. Every read/write filters `WHERE workspace_id = $ws::uuid`.

User scope (optional, within workspace): `(user_id = $u OR user_id IS NULL)`.

App scope: `app_id` column **stored but NOT enforced in SQL**. No `WHERE app_id = $app` filter found in any read path. **Cross-app facts are visible across the workspace today.** This is a finding worth flagging — Section 8 makes it a deliberate decision.

Service-key endpoints (`requireServiceKey`) are not workspace-aware by design — they are cross-tenant primitives meant for sibling-app calls; they accept `workspaceId` in body/query and trust the caller.

### 1.9 Inngest integration

**Search result: NONE FOUND in the memory layer.** Operator's stated context says "async writes via Inngest" — that is **a forward-looking statement, not the present state**. Today, every async memory write is a fire-and-forget JS Promise:

- `store.ts:292-299` — embedding update via `embed(...).then(...).catch(logger.error)`
- `conversation-bridge.ts:200` — `void extractTurn(...).catch(logger.warn)`
- `memory.ts:206-211` — `streamingTouchAfterStore(...)` w/ try/catch

Failures are logged, not retried. No durable queue, no DLQ, no retry policy. Inngest exists in the broader Plexo monorepo (per memory `service`) but the memory subsystem does not yet use it. **Real risk:** under load the embedder rate-limits → fact rows land with `embedding=NULL` → vector search misses them silently. There is no dead-letter queue, no backfill job.

### 1.10 Other load-bearing pieces

- `memory_themes` (Louvain/Leiden output, 3-level hierarchy, Phase-3 SCL promotion gate) — STABLE
- `memory_knn_edges` (precomputed cosine pairs for clustering + link suggestions) — STABLE
- `memory_theme_runs` (per-rebuild stats) — STABLE
- `concept_nodes / concept_edges / concept_membership` (ADR 0009 Phase 2) — JUST SHIPPED, in-progress
- `scl_concept_graphs` (zombie SCL table; active consumers in embeddings-reembed.ts + training-data.ts) — pending cleanup
- `extract-worker` (fact extraction from chat turns) — production
- `streamingTouchAfterStore` (incremental kNN refresh) — experimental

---

## Section 2 — Sibling App Requirements

### 2.1 Levio (calendar / email / tasks — VERY HIGH write volume)

SDK call sites (`/home/dustin/dev/joeybuilt/levio/src/lib/plexo/client.ts:26-92`): `dispatch`, `aiComplete`, `chatMessage`, `ensureWorkspace`, `autoAttachUser`, `getTasks`, `getTokens`. Notable absences: `storeMemory`, `searchMemory`, `graphMutate`. **Levio writes ZERO facts to Plexo memory today.**

Levio's own schema (`/home/dustin/dev/joeybuilt/levio/src/lib/db/schema.ts`):
- `calendarEvents` :277-313 — when/where/who/summary
- `tasks` :230-276 — description, dueAt, status, project, source enum includes `'fonto', 'nexalog', 'fylo', 'plexo_proposal'`
- `emails` :195-229 — from/subject/snippet/threadId/labels
- `commitments` :415-446, `awarenessItems` :447-472 (polymorphic flight/delivery/bill/rsvp)

Cross-app event LISTENER (stub): `src/app/api/plexo/events/route.ts:20` — accepts `tool.invoked`, `task.created`, `conversation.started`. **No materialization logic yet** (no-op handlers).

Volume: very high. Email ingestion alone is ~100–10k events/day per active user. If Levio's emails were materialized into Plexo memory, that is the critical write-volume case.

### 2.2 Nexalog (notes / bookmarks / URL entities — HIGH read, LOW write to Plexo)

SDK call sites (`/home/dustin/dev/joeybuilt/nexalog/lib/plexo.ts:12-183`): `aiComplete`, `searchMemory`, `publishEvent`, `getConversations`, `autoAttachUser`. Plus stub raw-fetch wrappers (now-superseded by graph methods): `plexoSclMutate / plexoSclExpand / plexoGoldenRecordMeta`.

Own schema (`lib/db/schema.ts`): `notes` :36-55, `captureSources` (bookmarks w/ rich enrichment) :58-152, `chatSessions/Messages` :259-286, `journalEntries` :404-432, `memoryThemes` :436-456 (local clustering output, separate from Plexo's), `bookmarkTags` :216-229.

Reads of Plexo memory:
- `lib/plexo.ts:70` — semantic re-rank (top-5)
- `lib/capture/duplicate-detector.ts:51` — duplicate detection probe
- `app/api/search/route.ts:459` — semantic re-rank of FTS
- `app/api/chat/[sessionId]/messages/route.ts:264` — context-aware chat
- `lib/auto-categorize.ts:36` — capture classification

Events PUBLISHED (3): `ext.nexalog.note.captured`, `ext.nexalog.bookmark.stale_batch`, `ext.nexalog.bookmark.worth_rereading`.

Volume: 10–100 captures/day, 1–10 notes/day. **Reads heavily; does NOT write facts.**

### 2.3 Fonto (file metadata / OCR / photo metadata — MEDIUM-HIGH write)

SDK call sites (`/home/dustin/dev/joeybuilt/fonto/lib/plexo.ts:6-134`): `storeMemory`, `searchMemory`, `aiComplete`, `visionOcr`, `publishEvent`. **The only sibling app that actively writes facts to Plexo memory today.**

Write site: `app/api/v1/assets/route.ts:157` writes asset metadata as a fact: `"[Fonto asset] ${filename}\nType: ${mimeType} | Classification: ${classification}\nDescription: ${description}\nContent: ${extractedText}"` with metadata `{source: 'fonto', assetId, classification, mimeType}`.

Reads: `app/api/v1/search/route.ts:115` (semantic re-rank), `app/api/v1/assets/[id]/similar/route.ts:54` (similarity).

Events (5): `ext.fonto.{asset.processed, document.processed, receipt.detected, asset.ocr_extracted, asset.uploaded}`.

Listener stub: `app/api/plexo/events/route.ts:32` for `ext.nexalog.fragment.archived` — no-op.

Own schema: `assets` :30-73 (OCR + perceptual hash + colors palette), `collections`, `tags`, `projects`, `correspondents`, `documentTypes`.

### 2.4 Pushd (notifications / deploy intelligence — LOW)

SDK call sites (`/home/dustin/dev/joeybuilt/pushd/apps/web/src/lib/plexo.ts:6-17`): `createPlexoClient`, `testConnection`. Plus AI-completion-only via `lib/plexo-deploy/*` — `analyze-repo.ts:15`, `diagnose-build-error.ts:14`, `pre-deploy-analysis.ts:16`, `monitor-deployment.ts:15`.

**Pushd reads zero memory facts and writes zero memory facts.** Pure AI-completion consumer. Greenfield for any memory integration.

### 2.5 Fylo (financial — HIGHEST sensitivity, NOT on disk locally)

Inferred from `service` memory (9-repo set: helm/platform/plexo/pushd/levio/fylo/fonto/nexalog/service). Fact shapes: transactions, balances, predictions, recurring subscriptions, budget anomalies. PII-dense and regulatorily-relevant (US tax + financial-privacy law). Anything Fylo writes to Plexo crosses a sensitivity boundary.

### 2.6 Helm (operational — deploys, incidents, config; NOT on disk locally)

Per operator clarification, "operational facts" surface is **Helm** (not Command Center). Helm is one of the 9 deploy-managed repos. Inferred fact shapes: deploys, incidents, config changes, build outcomes, deployment health timelines. Cross-app queries: "what changed on prod since the deploy" pulls Helm + Levio (calendar entries for change windows).

### 2.7 Cross-app queries (the load-bearing case for graph retrieval)

Today: **none implemented**. Apps own their data; no app queries another's domain. Plexo memory is per-app-scoped at the `app_id` column level (stored, not enforced).

Future intent (sourced from operator + the prompt + the 9-repo + Plexo agent code):
- "What's on my plate this week" → Levio (calendar, tasks) + Fylo (bills due) + Nexalog (notes tagged today)
- "Tell me about Project X" → Levio (meetings re X) + Nexalog (notes/bookmarks re X) + Fonto (files in X folder)
- "Did Sarah mention budget last month" → Levio (emails from Sarah) + Nexalog (notes re Sarah)
- "What changed on prod since the deploy" → Helm (deploys, incidents) + Levio (change-window calendar entries)
- "Which receipts are unmatched to expenses" → Fonto (OCR'd receipts) + Fylo (transactions)

These queries are the actual load-bearing case for graph-based retrieval. **They cannot be served today** because (a) sibling apps do not write structured facts to Plexo (only Fonto does), and (b) there is no cross-app retrieval surface in the SDK or in `queryMemory()`.

### 2.8 Architectural smell

`app_id` column on `memory_entries` is stored but never filtered on. Today this is benign because nothing writes cross-app facts. The moment Levio starts writing emails to Plexo memory, every `queryMemory()` call from Nexalog will surface them with no opt-in. **Section 8 makes this a deliberate decision.**

Plexo SDK integration is **partial and greenfield**. Levio + Pushd use Plexo for AI/dispatch only; Nexalog uses it for search/events; Fonto is the only active-writer. Treat the migration target as 80% greenfield.

---

## Section 3 — Graphiti Capability Mapping

| Required capability | Graphiti support | Notes / where the gap lives |
|---|---|---|
| Append-only fact storage with temporal edges | **Native** | `EntityEdge` has `created_at`, `valid_at`, `invalid_at`, `expired_at` first-class (`graphiti_core/edges.py`) |
| Per-fact provenance (source app, user, ts, source_text) | **Partial native** | `episodes: list[str]` ties facts to source episodes. App/user provenance must live on the `EpisodicNode` or in custom fields. |
| User-authored facts immune from automatic supersession | **Custom** | No first-class flag. Plexo would need a policy layer (reserved entity_type, or pre-write check) above Graphiti |
| Hybrid retrieval (semantic + keyword + graph traversal) | **Native** | `SearchConfig` recipes combine BM25/fulltext + vector + BFS; rerankers built-in (RRF, MMR, cross-encoder, episode-mentions, node-distance) |
| Per-user isolation (group_id) | **Native, but with a twist** | `group_id` is mandatory + first-class. **BUT** in `graphiti.py` `add_episode`, `group_id` triggers `self.driver = self.driver.clone(database=group_id)` — physical database per group. Strong isolation; ops impact at scale. |
| Per-app fact namespacing | **Custom (extend group_id pattern)** | No first-class app-scope. Could be encoded as `group_id = "{user}:{app}"` or via custom edge_type. Both make the "user only" query a prefix scan. |
| Per-app and per-user access control on reads | **Custom (policy layer)** | Plexo policy layer must validate `(caller_app, caller_user) → allowed_groups` before delegating to Graphiti |
| Async write ingestion (Inngest pipeline compat) | **Yes, with caveat** | `add_episode` is async, but docstring REQUIRES sequential per-group writes. Concurrent writes to same group are unsafe. Inngest must serialize per `group_id`. |
| Configurable embedding provider | **Native** | `EmbedderClient` ABC; first-party OpenAI/Azure/Gemini/Voyage; OpenAI client accepts `base_url` so Plexo Core's OpenAI-shaped embedding API plugs in cleanly |
| Configurable embedding dimension (256-dim Matryoshka) | **Yes, with one-way-door warning** | `EMBEDDING_DIM` env or `OpenAIEmbedderConfig(embedding_dim=N)`; truncates the model's vector to N. **Cannot enlarge** beyond the model's native dim. Changing dim post-write requires full re-embed of every edge. |
| Export format for data portability | **Yes (via underlying graph DB)** | Cypher dump / Neo4j backup / FalkorDB RDB / Kuzu Parquet exports. **NOT a Graphiti-level dump** — depends on chosen backend. |
| Write rate limiting / cost budgeting per app or user | **Custom** | Must live in Plexo policy layer; Graphiti has no built-in quota |
| Schema evolution without graph recomputation | **Partial native** | Custom `entity_types` / `edge_types` Pydantic models added at `add_episode` time — additive types do NOT require recompute. Changing existing-type semantics: no documented migration tooling (`graphiti_core/migrations/` is empty). |
| Pex-extension write surface (third-party apps writing facts) | **Custom (policy layer)** | Same as per-app access control; gate at Plexo policy layer |

**Net:** Graphiti covers ~60% of required capabilities natively, ~30% need a thin Plexo policy layer above it (per-app/per-user access, anchored facts, quotas), and ~10% are gaps we'd live with or build separately.

---

## Section 4 — Graph Backend Decision

**The hard fact (verified at audit time, 2026-05-09):** Graphiti supports exactly four graph backends — Neo4j, FalkorDB, Kuzu, Neptune — defined in `graphiti_core/driver/driver.py` `GraphProvider` enum. **Postgres / Supabase / pgvector is NOT supported.** Zero references in repo for "postgres", "pgvector", or "supabase" beyond incidental mentions.

The `GraphDriver` ABC at `graphiti_core/driver/driver.py:91` is in principle a custom-backend hook, but the interface assumes Cypher (`execute_query(cypher_query_, ...)`, `fulltext_syntax`, Cypher-shaped `SearchInterface`). **Building a Postgres backend means either translating Cypher to SQL inside the driver — a major project — or bypassing `execute_query` and reimplementing every operation in `driver/operations/*` (8+ ops modules). That is a fork, not an adapter.** Not realistic as a short-term integration.

So the real choice is: which of Neo4j / FalkorDB / Kuzu / Neptune for Plexo?

| Backend | Compat w/ JB infra | Ops complexity | License | Query expressiveness | Write performance | Storage @ scale | Backup story |
|---|---|---|---|---|---|---|---|
| **Neo4j** 5.26+ | New service alongside Postgres on OVH VPS | Medium-High (cluster ops, JVM tuning, plugins) | Community = GPLv3; Enterprise = commercial | Excellent (Cypher mature, 25+ years) | Good w/ tuning; per-tenant DB requires Enterprise (community = single DB) | Index-heavy; ~2–3× raw fact size | Rich (neo4j-admin dump/load) |
| **FalkorDB** 1.1.2+ | Redis-compatible; lightweight, runs anywhere | Low (single Redis-shaped binary) | Server Side Public License (SSPL) — **NOT OSI-approved**; commercial concerns | Cypher (subset, fewer features than Neo4j) | Very fast write throughput; in-memory primary | Memory-bound — RAM must hold the working set. Persistent via Redis AOF/RDB. | Standard Redis BGSAVE / AOF |
| **Kuzu** 0.11.2+ | Embedded library + standalone server; runs on the same VM as Plexo | Very low (embedded option) | MIT | Cypher (subset) | Excellent for analytical / batch; single-writer model | Columnar; smallest footprint | DB file copy |
| **Neptune** | AWS-only | None (managed) but requires AWS — JB is on OVH VPS today | Commercial (AWS) | Cypher / Gremlin / SPARQL | Auto-scaling | Per-AWS-pricing | AWS automated backups |

**Recommendation: Kuzu (if Graphiti migration goes ahead).**

Why:
- Embedded mode runs on the same VPS as Plexo — no new service to monitor, no cross-host network hop on writes
- MIT license is unambiguously OSS-friendly (vs. Neo4j Community's GPLv3 viral risk and FalkorDB's SSPL)
- Smallest storage footprint at our expected fact volumes (~10k–10M facts per workspace over years)
- Standard DB-file backup (cp / rsync) — fits existing OVH VPS backup tooling
- Single-writer model is acceptable because Graphiti already requires sequential per-group writes (Section 3)

Why not the alternatives:
- **Neo4j**: heavyweight; per-tenant database isolation needs Enterprise (cost); GPLv3 community has concerns when redistributed in an AGPL product (not a license conflict, but a packaging headache)
- **FalkorDB**: SSPL is a no-go for Plexo's OSS posture; in-memory primary limits scale
- **Neptune**: requires AWS migration; out of scope

### Pre-mortem (assume Kuzu turns out wrong in 18 months)

1. **Kuzu's single-writer model becomes a throughput bottleneck under Levio email ingestion.** Fallback: switch to FalkorDB (Redis-shaped, fast writes); accept SSPL risk because Plexo Core never ships FalkorDB binaries to consumers — it runs server-side only.
2. **Kuzu's Cypher subset turns out to lack a feature Graphiti's `SearchConfig` recipes start using in a future minor.** Fallback: pin Graphiti version + maintain compatibility shim until Kuzu catches up. Or migrate to Neo4j Community (heavier but full Cypher).
3. **Embedded Kuzu's lock-file model wedges under multi-process Plexo workers.** Fallback: switch to Kuzu standalone server mode; one-line config change. Proven before commitment.

---

## Section 5 — Embedding Strategy

- **Provider:** Plexo Core's inference router (the future Plexo Inference Gateway) — exposed as an OpenAI-compatible endpoint. Graphiti's `OpenAIEmbedderConfig(api_key=…, base_url=…)` plugs in directly with no fork.
- **Model:** the operator's locked decision is **256-dim Matryoshka-truncated**. The most common Matryoshka-trained models today are OpenAI `text-embedding-3-small` (native 1536, supports `dimensions` API param down to 256+) and `text-embedding-3-large` (3072 native). Either truncates to 256 cleanly. **Local Xenova models do NOT support Matryoshka truncation natively** — flag for the inference-gateway design.
- **Dimension:** Graphiti's `EMBEDDING_DIM` env supports 256; the OpenAI-compatible response gets sliced. Set once before any writes; **never change after** (full re-embed required).
- **Existing embeddings:** today's `memory_embeddings` and `concept_nodes.embedding` columns are 384-dim. **Migration cost:** if Graphiti is adopted, every existing fact must be re-embedded at 256-dim through the new pipeline. At current corpus sizes (probably <100k facts across all workspaces) this is cheap (~$5–20 OpenAI bill), but it is a one-shot job that must be scripted.
- **Plexo Inference Gateway requirements (forward-looking, must be locked before Graphiti adoption):**
  1. Embedding endpoint must be OpenAI-compatible (`POST /embeddings` returning `{data: [{embedding: [...]}]}`)
  2. Must support `dimensions` query param (Matryoshka truncation)
  3. Must support batched input (`input: ["t1", "t2", ...]`) — Graphiti batches per-episode

---

## Section 6 — What Gets Ripped Out (if Graphiti goes ahead)

Concrete file/schema list. Estimates conservative.

| Item | What | LOC / size |
|---|---|---|
| `packages/agent/src/memory/graph-query.ts` | Just-shipped concept-graph layer | ~250 LOC |
| `packages/agent/src/memory/__tests__/graph-query.test.ts` | Tests of above | ~210 LOC |
| `apps/api/src/routes/graph.ts` | Just-shipped graph endpoints | ~115 LOC |
| `apps/api/src/__tests__/graph-routes.test.ts` | Tests of above | ~190 LOC |
| `packages/db/drizzle/0118_concept_graph_phase_1.sql` | Schema for concept_*tables | ~80 LOC |
| `concept_nodes / concept_edges / concept_membership` schema | drizzle definitions | ~80 LOC |
| `packages/agent/src/memory/knn.ts` | Manual kNN edge refresh | ~150 LOC |
| `packages/agent/src/memory/cluster.ts + cluster-api.ts` | Louvain/Leiden clustering — replaced by Graphiti's community detection | ~600 LOC |
| `memory_themes / memory_knn_edges / memory_theme_runs` schema | drizzle definitions | ~80 LOC |
| `packages/agent/src/memory/scl.ts` | `is_scl` theme-promotion gate | ~290 LOC |
| `packages/agent/src/memory/write.ts` | LLM-driven conflict classifier — Graphiti has its own supersession | ~250 LOC |
| `packages/agent/src/memory/extract-worker.ts` | Custom fact extractor — Graphiti's `add_episode` does its own LLM extraction | ~150 LOC |
| Bespoke triple extraction (subject/predicate/object columns + write logic) | Replaced by Graphiti entity/edge extraction | scattered |
| HNSW index management (m=16, ef_construction=64) | Replaced by Graphiti backend's index | minimal |
| `packages/agent/src/memory/graph-query.ts` linker hookup in `extract-worker.ts:130-138` | Becomes a Graphiti add_episode call | a few lines |
| SCL leftovers still pending Phase 4 cleanup | embeddings-reembed.ts SCL branch + scl_concept_graphs table + training-data SCL fixture | ~80 LOC |
| `packages/sdk/src/connect/client.ts` graphMutate/graphExpand/graphMeta/graphExtractTrigger methods | Replaced w/ a Graphiti-shaped API surface — could rename + adjust | ~70 LOC |
| `packages/sdk/CHANGELOG.md` 1.1.0 graph entry | Rewrite for whatever migration version ends up shipping | small |

**Total: roughly 2300–2700 LOC removed plus 4 schema tables dropped (`concept_nodes`, `concept_edges`, `concept_membership`, `scl_concept_graphs`) plus the auxiliary `memory_themes / memory_knn_edges / memory_theme_runs` cluster ecosystem if Graphiti's communities replace them.**

---

## Section 7 — What Stays

- **Plexo Core's HTTP interface** (`apps/api/src/routes/memory.ts`, `apps/api/src/routes/graph.ts`) — the endpoint shapes stay; the implementations delegate to Graphiti instead of in-house code. Sibling apps continue to call Plexo, not Graphiti directly. **This is the architectural lock.**
- **Service-key auth + workspace-membership middleware** — `requireServiceKey`, `requireWorkspaceMember`. Multi-tenant isolation (the Plexo policy layer) sits ABOVE Graphiti.
- **User-authored-immune rule** — implemented in the policy layer (pre-write check on `is_anchored` or equivalent).
- **`memory_entries` table itself** — likely stays as the canonical fact store, with Graphiti as the search/graph index over it. Or the table is retired and Graphiti's episodic store becomes canonical. **Decision to make.**
- **Inngest async write pipeline** (when wired) — still serializes per group_id before delegating to Graphiti `add_episode`. Inngest is the right place to enforce "sequential per-group write" requirement.
- **`reflectOnTask` and task→memory extraction** — feeds into Graphiti via a thin adapter that turns task summaries into episodes.
- **`buildIntrospectionSnapshot`** (Plexo's self-model) — separate concern, not memory-layer.
- **RSI loop** (`packages/agent/src/introspection/rsi-monitor.ts`) — entirely separate.
- **A2A / Pex protocol** — separate.
- **`memory_entries` Phase-1 supersession columns** (`superseded_by`, `invalid_at`, `is_anchored`) — remain useful for the policy layer's anchor-check even if Graphiti owns the read path.
- **Embedding adapter resolution** (`store.ts:125`) — adapt to call Graphiti's embedder OR keep Plexo's adapter and inject it into Graphiti via `EmbedderClient` subclass. Either way, Plexo-side workspace settings + circuit breaker + LRU stay relevant.

---

## Section 8 — Cross-App Architecture Decisions Required

These must be decided deliberately during the migration, not deferred.

### 8.1 Default cross-app access (Levio reading Fylo)

**Default proposed:** **DENY by default.** Each app sees only its own facts unless the user explicitly grants cross-app read.

**Cost of wrong choice (ALLOW-by-default):** Levio queries surface Fylo financial data without consent. Regulatory exposure (US financial-privacy law). **Pick DENY.**

Implementation: Plexo policy layer attaches `(caller_app, caller_user)` to every read, intersects with allowed-groups list before delegating to Graphiti.

### 8.2 Write rate limiting

**Default proposed:** Per-app + per-user combined token-bucket. Default burst 100, refill 100/min. Per-app overrides per workspace.

**Cost of wrong choice (no rate limit):** Levio runaway email ingestion blows out the LLM bill (Graphiti's per-write LLM extraction). **Pick combined limit.**

Implementation: Inngest's built-in concurrency + rate limit primitives, gated per `group_id`.

### 8.3 Fact retention policy

**Default proposed:** Keep forever. Archive (set `tier='cold'`) at 18 months of no retrieval. Summarize (LLM-condense) at 5 years.

**Cost of wrong choice (aggressive prune):** loses long-tail facts the user later asks about. Storage is cheap; user trust is not. **Pick keep-forever w/ tier-based archive.**

### 8.4 Export format spec

**Default proposed:** JSON-Lines; one fact per line; schema documented at `docs/memory-export-format.md` (TBD). Includes provenance, supersession chain, embedding (optional).

**Cost of wrong choice (proprietary format):** users cannot leave; violates People's Model Commons portability principle. **Pick documented JSONL.**

### 8.5 People's Model Commons compatibility

**Default proposed:** Provenance distinguishes user-authored, agent-extracted, third-party-extracted (via `source` column + Graphiti `episodes` provenance). User-authored is the only source whose extracted derivatives may be re-shared without per-fact opt-in.

**Cost of wrong choice (no distinction):** third-party content (e.g., a copyrighted article a user bookmarked, Plexo extracts entities, those entities get re-shared) — copyright + attribution failure. **Pick three-way distinction.**

### 8.6 Pex extension write permissions

**Default proposed:** Pex extensions are sandboxed; can write only to a quarantine namespace (`group_id = "quarantine:{ext_id}"`). User must explicitly graduate facts to their primary group.

**Cost of wrong choice (write directly to user group):** malicious or buggy extension pollutes the user's memory permanently. **Pick quarantine.**

---

## Section 9 — Cost & Operational Considerations

### 9.1 Inference cost for Graphiti's per-write LLM extraction

Graphiti's `add_episode` invokes an LLM per call for entity extraction + relationship extraction + deduplication + summarization. **Two real mitigations are first-class in Graphiti and meaningfully change the cost story; one workaround is not first-class and has open ambiguity.**

**Mitigation 1 (verified, first-class) — provider routing via `LLMConfig.base_url`.** `graphiti_core/llm_client/config.py` exposes `base_url`, plumbed to `AsyncOpenAI(api_key=…, base_url=…)` in `openai_client.py`. Plexo's OpenAI-compatible inference gateway can serve Graphiti's LLM calls with no fork. Extraction quality requirements are lower than user-facing inference, so extraction can route to a cheap local model (Ollama in dev; Plexo Gateway → small model in prod) without quality regression on the user-facing path.

**Mitigation 2 (verified, first-class) — 2-tier `model` / `small_model` split.** `LLMConfig` accepts both `model` and `small_model`. `small_model` is documented as used for "reranking, cross-encoding, entity attribute summarization, relationship dedup." So extraction can run on a mid-tier model while dedup/summary runs on a cheap one. Per-call arbitrary model override is NOT supported, but the 2-tier split covers the most cost-sensitive paths.

**Workaround (NOT first-class, ambiguous semantics) — `add_fact_triple` for pre-structured writes.** When the caller already knows the entities/edges (Levio knows a calendar event IS a calendar event; Fonto knows an asset's classification), `add_fact_triple` lets the caller construct `EntityNode` / `EntityEdge` manually and bypass the extraction LLM call. **HOWEVER:** Graphiti Issue #1193 (open, no maintainer reply since 2026-02-02) flags ambiguity on whether embedding/dedup LLM calls still fire on this path. Issue #1299 explicitly requests a clean skip-extraction mode for `add_episode` / `add_episode_bulk`; also open with no maintainer response. **Until those issues resolve, the bypass is real but unsupported; counting on it is a bet on the maintainer's roadmap.**

**`add_episode_bulk` does NOT batch LLM calls.** Per `graphiti_core/utils/bulk_utils.py`: `extract_nodes_and_edges_bulk` parallelizes via `semaphore_gather` but issues per-episode LLM calls (1 if `use_combined_extraction`, else 2). Dedup passes are 1 call per episode + 1 call per candidate edge. Bulk gives wall-clock speedup via concurrency, not per-call cost reduction.

**Quantified cost (with mitigations applied):**
- Without mitigations, structured-fact-heavy ingestion: `gpt-4o-mini` at ~3K input + 1K output per episode = **~$0.001 per write**
- With `small_model` split + Plexo gateway routing extraction to a local Ollama model: the per-write fee can drop ~5–10× for the cost-sensitive ingestion path. Honest range: **~$0.0001–$0.0005 per write**.
- With `add_fact_triple` bypass for fully pre-structured Levio/Fonto writes (IF the open issues resolve favorably): per-write extraction cost goes to zero; only embedding cost remains (~$0.00002 per write at OpenAI 256-dim).

**Levio email ingestion stress test (1k emails/day/user, 100 active users):**
- Worst case (all `add_episode`, mid-tier model, no mitigations): **~$3,000/month**
- With mitigations (gateway-routed extraction on small model + `small_model` split for dedup): **~$300–600/month**
- With `add_fact_triple` bypass for pre-structured email metadata (IF Issue #1299 lands): **~$30–60/month** plus embedding cost

**This is genuinely tunable; not a blocker. Section 8.2 (per-app rate limiting) is the policy knob; Sections 5 + 9.4 (gateway design) is the architecture knob.** The honest residual concern is the dependency on the `add_fact_triple` workaround being officially blessed — without it, structured-fact ingestion costs ~10× more than a path that has it. That's a maintainer-roadmap bet.

### 9.2 Backup strategy

**Kuzu:** standard file copy. Snapshot pre-deploy; rsync to backup VPS. Restore = stop + replace + start.

### 9.3 Migration cost

- Re-embedding existing facts at 256-dim: ~$5–20 (small corpus today)
- Schema migration: idempotent SQL drop migrations for the in-house tables; Kuzu DB starts empty
- Downtime tolerance: read-only mode for 10–30 minutes during cutover; writes queued to Inngest
- Engineering time: 3–6 weeks fulltime to migrate Plexo Core + sibling integration

### 9.4 Self-hoster impact

Self-hosters get an embedded Kuzu DB inside the same Plexo container — no extra service to deploy. Inference provider remains the self-hoster's choice (Graphiti's `EmbedderClient` honors `base_url`, so Ollama / LiteLLM / etc. work with no fork). **No impact to self-hoster posture.**

---

## Section 10 — Recommendation

### 10.1 Per-expert go/no-go (six experts; conflicts surfaced, not smoothed)

**1. Retrieval Systems Engineer — LEAN YES (with caveat).**
> Graphiti's hybrid `SearchConfig` recipes (semantic + BM25 + BFS + RRF/MMR/cross-encoder reranking) are mature and would replace ~600 LOC of in-house clustering + ~250 LOC of `queryMemory` retrieval logic. Net retrieval quality on the cross-app queries (Section 2.7) will be measurably higher than the current top-k pgvector approach. **Caveat:** the per-write LLM extraction cost (Section 9.1) is real. If we lean YES, we must pair it with strict per-app rate limiting (Section 8.2).

**2. Knowledge Graph Architect — STRONG YES.**
> Temporal edges (`valid_at` / `invalid_at` / `expired_at`) are first-class. Entity resolution via deduplication on each episode is exactly the missing piece in the current atomic-fact model. Custom `entity_types` + `edge_types` Pydantic models give us the ontology evolution path without a recompute. Community detection replaces Louvain/Leiden cluster code. **The graph layer is what Plexo memory should have been from the start; building it ourselves is duplicating well-trodden ground.**

**3. Distributed Systems Engineer — CONDITIONAL YES (revised after Inngest verification).**
> Initial concern about "sequential per-group writes capping throughput" was wrong. Verified: Inngest's `concurrency: { key: "group_id", limit: 1 }` config creates a virtual queue per unique `group_id`; distinct groups run in parallel. Aggregate throughput scales horizontally with worker count + LLM provider RPM, not bounded by serialization. **Per-group serialization is correct behavior for temporal consistency, not a bug.** Real residual concern: per-group latency for chatty single users (back-to-back writes from same `group_id` queue serially behind extraction latency of 5–30s/call). Not relevant to Levio's many-users many-emails scenario; potentially relevant to a single power-user with rapid in-session captures. The other residual concern — `group_id`-mapped-to-physical-database in Graphiti — remains real for ops complexity at thousands of users (Section 4 backend choice mitigates).

**4. Agent Memory Specialist — SPLIT.**
> The retrieval improvement matters at inference time (better top-k for the agent prompt block; community summaries help with "what do I know about X" queries). **But:** the write→read loop becomes seconds-to-tens-of-seconds slower — a fact captured in chat may not be retrievable in the same turn or even the next turn until Graphiti's async extraction completes. For the conversational fast-path, this is a regression vs. today's `memory_entries` insert + immediate vector retrieval. **Conflict surfaced, not resolved:** the retrieval-quality gain and the write→read latency regression both exist. Whether the latency cost is acceptable depends on what fraction of inference-time queries depend on facts captured in the same session — a measurement we have not made. **Decision deferred to operator on the basis of measured same-session-recall frequency.**

**5. Open Source Strategist — YES.**
> Apache-2.0 → AGPL-3.0 is a clean direction (Apache-licensed code embeds in AGPL projects with no patent flow-back issues). 25,855 stars + 77 commits in last 90 days + corporate maintainer (Zep Software) → bus factor is acceptable but not trivial. The single-vendor risk (Zep pivots / is acquired) is mitigated by the 2.5k forks → fork-and-maintain is realistic if it comes to that. **Recommend pinning to a Graphiti minor + treating each upstream bump as an explicit upgrade event.**

**6. Security / Access Control — CONDITIONAL YES.**
> `group_id` first-class is a strong primitive for per-user isolation; better than the current `app_id` column that is stored-but-not-enforced. Mapping group_id → physical database in Graphiti is a *security feature* (no risk of a query forgetting the WHERE clause) but an *ops cost* at scale. Per-app access (Section 8.1) and Pex sandboxing (Section 8.6) MUST be implemented in the Plexo policy layer above Graphiti — Graphiti has no per-app concept. **Conditional on Section 8.1 + 8.6 being committed before the migration starts.**

### 10.2 Consolidated panel recommendation

**The panel does not reach unanimous consensus. That is the finding. The audit does not collapse it into a compromise architecture.**

After post-audit verification of three originally-overstated concerns:

| Concern | Status after verification |
|---|---|
| Per-write LLM extraction cost | Real but tunable. `LLMConfig.base_url` routing + 2-tier `model`/`small_model` split drop cost 5–10× without `add_fact_triple` bypass; another 5–10× with it (subject to Issue #1299 resolution). |
| Sequential per-group writes cap throughput | **Wrong as stated.** Inngest fans out across distinct group_ids; per-group serialization is correct behavior for temporal consistency. Real residual concern: per-group latency for a chatty single user (5–30s/call queue), not aggregate throughput. |
| No Postgres backend | **Verified.** Graphiti supports Neo4j / FalkorDB / Kuzu / Neptune. Issue #779 (Postgres support) open since 2025-07-28 with no maintainer roadmap response. Adopting Graphiti means adopting one of the four supported backends. Section 4 recommends Kuzu. |

**Net of verification:** the YES camp's case strengthens (extraction is tunable; throughput is not capped); the NO camp's case narrows to (a) per-group latency for chatty single users, (b) dependency on `add_fact_triple` becoming officially supported, (c) backend ops cost.

The panel still does not converge. Three forks remain on the table; **the audit deliberately does not pick one** because the choice depends on measurements we have not made (same-session-recall frequency, current corpus size, expected per-user write rate) and on operator priorities (lock-in tolerance, ops appetite, OSS-strategy preferences).

**The three forks (operator picks):**
1. **Wholesale replace.** Graphiti becomes the canonical memory engine. Phase 2 concept_graph (just shipped) is reverted. Sibling apps still call Plexo Core; Plexo Core delegates to Graphiti.
2. **No adoption.** Stay on the in-house atomic-fact + concept_graph trajectory. Continue the Phase 2/3/4 work as ADR 0009 plans.
3. **Time-box a spike.** Fixed-scope spike (e.g., 2 weeks) with concrete pass/fail criteria — Levio email ingestion at expected volume, same-session-recall measured, cost over the spike window quantified, ops complexity assessed. Decision after spike, not before.

The Agent Memory Specialist's "two-tier" idea was raised in Section 10.1 — it is **not** elevated to a recommendation here. Operator pushback is correct that running both engines in parallel doubles maintenance, splits source-of-truth, and locks in code we may want to delete. Two-tier is a *deferral*, not a *decision*; the audit refuses to recommend deferral.

### 10.3 One-way doors requiring operator sign-off before execution

**These must be decided before any migration prompt is drafted.**

1. **Adoption decision: wholesale-replace vs. no-adoption vs. time-boxed spike (Section 10.2 forks).** This is the gating decision. The Phase 2 concept_graph fate (delete vs. keep) follows from this.
2. **Graph backend choice (Kuzu vs. Neo4j vs. FalkorDB vs. Neptune).** Section 4 recommends Kuzu (MIT, embedded, smallest footprint, fits OVH VPS). Postgres is not on the menu (Section 4 verified).
3. **Embedding dimension lock at 256-dim Matryoshka.** Operator's stated lock; reaffirming because changing post-write requires full re-embed of every Graphiti edge.
4. **`group_id` mapping.** `user_uuid` alone? `{user_uuid}:{app_id}`? Decision determines whether per-app reads are a prefix scan or a separate physical database.
5. **Section 8.1 cross-app access default — DENY-by-default.** Locks the Plexo policy-layer architecture.
6. **Section 8.2 per-app + per-user rate-limit policy.** Inngest config decision; gates LLM-cost exposure.
7. **Section 8.6 Pex extension quarantine.** Locks the Pex security model.
8. **Inngest formal adoption for memory-layer async.** Today the memory layer uses fire-and-forget JS Promises, NOT Inngest (Section 1.9). Graphiti adoption depends on durable per-group serialization; Inngest has to be wired BEFORE Graphiti.
9. **Spike pass/fail criteria (only if door #1 = spike).** What measurements decide adoption? Likely candidates: Levio email ingestion at peak volume w/ measured cost; same-session-recall frequency before/after; ops complexity vs. baseline.
10. **Migration order (only if door #1 = wholesale).** Plexo Core delegation cutover first? Or sibling apps cut over to writing through Plexo memory first?

**The migration prompt is NOT to be drafted until at least door #1 is signed off.** Doors #2–#8 follow from #1.

---

## Appendix A — Verified Facts Cited

- Graphiti license + activity: https://github.com/getzep/graphiti, latest release v0.29.0 (2026-04-27)
- Graphiti backends: `graphiti_core/driver/driver.py` `GraphProvider` enum (Neo4j, FalkorDB, Kuzu, Neptune)
- Graphiti embedder: `graphiti_core/embedder/openai.py`, `client.py` (EMBEDDING_DIM env, base_url override)
- Graphiti **LLM** routing: `graphiti_core/llm_client/config.py` exposes `LLMConfig.base_url`, plumbed to `AsyncOpenAI` in `openai_client.py`. 2-tier `model` / `small_model` split documented at https://help.getzep.com/graphiti/configuration/llm-configuration
- Graphiti temporal edges: `graphiti_core/edges.py` (created_at, valid_at, invalid_at, expired_at)
- Graphiti `group_id`-as-database: `graphiti.py` `add_episode` `self.driver.clone(database=group_id)`
- Graphiti `add_episode_bulk` does NOT batch LLM calls: `graphiti_core/utils/bulk_utils.py` (`extract_nodes_and_edges_bulk` parallelizes per-episode invocations via `semaphore_gather`)
- Graphiti `add_fact_triple` bypass for pre-structured writes: https://help.getzep.com/graphiti/working-with-data/adding-fact-triples (semantics ambiguous per open Issues #1193, #1299)
- Graphiti Postgres backend status: Issue #779 open since 2025-07-28, no roadmap response; no community fork found in any working state (verified via fork search at https://github.com/getzep/graphiti/network/members)
- Inngest per-key concurrency model: https://www.inngest.com/docs/guides/concurrency — `concurrency: { key, limit }` creates a virtual queue per unique key value; distinct keys run in parallel
- Plexo memory layer: subagent inventory at HEAD (`packages/agent/src/memory/*.ts`, `packages/db/src/schema.ts:653-2086`)
- Sibling app SDK usage: levio/fonto/nexalog/pushd `lib/plexo*.ts` files
- HNSW params: `packages/db/drizzle/0102_memory_rebuild_phase1.sql:44-46`
- SEC-028 (no Postgres RLS): `packages/db/src/schema.ts:4`

## Appendix B — Items Marked NOT VERIFIED

- Graphiti contributor count / bus factor: GitHub `/stats/contributors` returned empty on first call (async-computed). Manually inspect `https://github.com/getzep/graphiti/graphs/contributors` before commitment.
- Fylo + Helm fact shapes: repos not on disk locally; inferred from operator guidance + the 9-repo memory.
- Plexo Inference Gateway embedding endpoint shape: forward-looking; not yet implemented in Plexo Core.
- Graphiti backup tooling beyond "use the underlying backend's tools": no Graphiti-level backup docs found.
- Existing Plexo embedding corpus size: not measured. Migration cost estimate (~$5–20) assumes <100k facts total across all workspaces; verify before commitment.
