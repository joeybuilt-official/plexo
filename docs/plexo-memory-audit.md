# Plexo Memory System — Surgical Audit
Generated: Phase 0
Raw grep sources: memory-audit-scl-imports.txt, memory-audit-writes.txt, memory-audit-reads.txt

---

## Critical Flags

### ⚠️ NO INNGEST INSTALLED
The plan's write path (Phases 3, 7) specifies Inngest as the async job runner, but Inngest is **not present** in this repo.
Existing background job infrastructure:
- `apps/api/src/cron.ts` — node-cron scheduler, registers all periodic jobs
- `apps/api/src/cron/synthesis-nightly.ts` — example nightly job pattern
- `apps/api/src/lib/embeddings-reembed.ts` — in-memory job map for long-running background ops
- `apps/api/src/federation/event-processor.ts` — event-based async processing

**Resolution:** Phases 3 and 7 must adapt to this infrastructure. `memory/extract-turn` becomes a fire-and-forget async function called directly from conversation-bridge. Cron jobs (flush-retrieval-counts, decay-confidence) register in `apps/api/src/cron.ts` following the synthesis-nightly pattern. No Inngest install needed.

### ⚠️ memory_entries MISSING user_id COLUMN
Current `memory_entries` schema scopes to `workspace_id` only — no `user_id` column.
Plan's Phase 1 adds columns referencing user_id in WHERE clauses (query.ts, active index).
Need to add `userId` to the schema extension in Phase 1 OR adjust Phase 4 queries to use workspace_id only.

---

## 1. SCL Import Map

### DELETE — remove import and all code that exclusively consumed it

| File | Line(s) | Symbol | Notes |
|---|---|---|---|
| `apps/api/src/routes/chat.ts` | 42 | `recallPriorConversation` import | Barrel import from channel-ai |
| `apps/api/src/routes/chat.ts` | 620 | `recallPriorConversation(...)` call | Full call block |
| `apps/api/src/routes/chat.ts` | 666–672 | `expandForConversation` import + call | Hot path — Phase 2 target |
| `apps/api/src/channel-ai.ts` | 624–625 | `expandForConversation` import + call | Channel AI hot path — Phase 2 target |
| `apps/api/src/channel-ai.ts` | 1319–1416 | `recallPriorConversation` function def | Function + error handler block |
| `apps/api/src/routes/discord.ts` | 31, 293 | `recallPriorConversation` import + call | Same pattern as chat.ts |
| `apps/api/src/routes/slack.ts` | 26, 433 | `recallPriorConversation` import + call | Same pattern as chat.ts |
| `apps/api/src/routes/telegram.ts` | 39, 889 | `recallPriorConversation` import + call | Same pattern as chat.ts |
| `apps/api/src/routes/scl-admin.ts` | entire file | MindsetObject/compressToMindsetObject/workspace_mindsets | Admin route — delete whole file + router mount |
| `apps/api/src/routes/scl.ts` | entire file | loadGoldenRecord/saveGoldenRecord/mutate/resolveDrift | SCL management routes — delete whole file + router mount |
| `apps/api/src/agent-loop.ts` | 670 | `ResolutionLevel` from `@plexo/scl-core` | Inline type assertion |
| `apps/api/src/agent-loop.ts` | 939–953 | `compressToMindsetObject` + workspace_mindsets upsert | SCL-D compression block inside agent loop |
| `apps/api/src/routes/training-data.ts` | 96–98 | workspace_mindsets table/count/sample SQL | Delete those 3 lines from the table config array |
| `packages/agent/src/executor/index.ts` | 738–763 | `mindset_object` query + `expandMindsetObject` | SCL-D task context expansion block |
| `vitest.config.ts` | 21–22 | `@plexo/agent/scl/expand-context`, `@plexo/scl-core` aliases | Delete after Phase 5 |
| `apps/api/src/routes/__tests__/scl-drift-inbox.test.ts` | entire file | scl-core mocks | Test for deleted route |
| `apps/api/src/routes/__tests__/scl-rsi-inbox.test.ts` | entire file | scl-core mocks | Test for deleted route |
| `apps/api/src/routes/__tests__/scl-attractors.test.ts` | entire file | scl-core mocks | Test for deleted route |
| `tests/e2e/p6-scl-runtime.spec.ts` | entire file | MindsetObject e2e | Tests for deleted functionality |
| `tests/e2e/p7-scl-ui.spec.ts` | entire file | MindsetObjectViewer e2e | Tests for deleted UI |

### MIGRATE — replace with equivalent from new memory system

| File | Line(s) | Symbol | Replacement |
|---|---|---|---|
| `packages/agent/src/foundry/shadow.ts` | 15 | `cosineSimilarity from @plexo/scl-core` | Inline: `a.reduce((s,v,i) => s + v*b[i], 0)` — 1-line dot product on unit vectors |
| `packages/agent/src/memory/conversation-bridge.ts` | 220–316 | SCL mutation block (loadGoldenRecord, mutate, saveGoldenRecord) | Replace entire function body (Phase 3) — fire-and-forget async extract call |
| `apps/api/src/routes/chat.ts:630` area | ~630 | Direct `memory_entries` vector similarity SQL | Replace with `queryMemory()` call (Phase 9) |

### MIGRATE (UI) — Phase 8 builds replacement, delete old after

| File | Symbol | Action |
|---|---|---|
| `apps/web/src/app/app/memory/page.tsx` | MindsetObjectViewer, GoldenRecordDashboard, MindsetObject type | Gut and replace with Phase 8 MemoryPanel |
| `apps/web/src/app/(dashboard)/insights/page.tsx` | MindsetObjectViewer, MindsetObject type | Remove SCL viewer; keep or adapt page wrapper |
| `apps/web/src/app/app/tasks/[id]/_scl-disclosure.tsx` | MindsetObjectViewer | Delete entire component |
| `apps/web/src/components/scl/AttractorBrowser.tsx` | entire file | DELETE |
| `apps/web/src/components/scl/GoldenRecordDashboard.tsx` | entire file | DELETE |
| `apps/web/src/components/scl/MindsetObjectViewer.tsx` | entire file | DELETE (after Phase 8 ships) |

### KEEP — these files/references are NOT deleted

| File | Symbol | Notes |
|---|---|---|
| `packages/agent/src/memory/store.ts` | interface + function stubs | Interface survives; implementation replaced Phase 4 |
| `packages/agent/src/memory/conversation-bridge.ts` | hook signature | Signature survives; body replaced Phase 3 |
| `packages/agent/src/embeddings/router.ts` | EmbeddingRouter | Survives; updated for 256-dim in Phase 4 |
| All `packages/scl-core/` internal files | — | Deleted wholesale as a directory in Phase 5 — no surgical editing needed |

### FLAG — manual review required before Phase 5

| File | Line(s) | Issue |
|---|---|---|
| `packages/agent/src/scl/task-expansion.ts` | 12–13 | Uses `expand`, `cosineSimilarity`, `ResolutionLevel` from scl-core for task expansion in agent. If agent task expansion is still needed post-revamp, a replacement must be designed before Phase 5 deletes scl-core. If not needed, delete whole file. |
| `packages/agent/src/scl/cross-app.ts` | entire file | Cross-app SCL knowledge transfer — unclear if this capability is preserved post-revamp. FLAG for product decision. |
| `packages/agent/src/memory/scl.ts` | entire file | Reads memory_entries to feed SCL scoring; used by RSI/synthesis path. Review what consumers call this before deleting. |
| `apps/api/src/routes/__tests__/chat-quality.test.ts` | 205–206 | Mocks `expandForConversation` — update mock after Phase 2 removes the call site |

---

## 2. Write Surface

### KEEP — moves to async path (Phase 3 Inngest-equivalent)

| File | Lines | Description |
|---|---|---|
| `packages/agent/src/memory/conversation-bridge.ts` | ~138 fn | Post-turn extraction hook — body replaced, signature kept |
| `packages/agent/src/memory/store.ts` | 288, 301, 315 | Embedding updates on write — refactored in Phase 4 |

### KEEP — legitimate production writes, not touched

| File | Operation | Notes |
|---|---|---|
| `apps/api/src/routes/memory.ts` | INSERT/UPDATE/DELETE memory_entries | Memory CRUD route — keep, may gain new columns |
| `packages/mcp-server/src/tools/memory.ts:83` | INSERT memory_entries | MCP tool write — keep |
| `apps/api/src/cron/synthesis-nightly.ts:92,294` | UPDATE memory_entries embedding | Nightly backfill — keep |
| `apps/api/src/lib/embeddings-reembed.ts:222` | UPDATE memory_entries embedding | Re-embed job — keep |
| All backfill scripts | INSERT/UPDATE | One-time scripts — keep |

### DELETE

| File | Lines | Reason |
|---|---|---|
| `apps/api/src/routes/scl-admin.ts:116-121` | workspace_mindsets UPSERT | Deleted with whole file |
| `apps/api/src/agent-loop.ts:948-953` | workspace_mindsets UPSERT | Deleted in Phase 2/5 block removal |
| `packages/agent/src/scl/storage.ts:47-55` | workspace_mindsets UPSERT | Deleted with scl package |

---

## 3. Read Surface

### REPLACE-WITH-QUERY (Phase 9)

| File | Lines | Current | Replacement |
|---|---|---|---|
| `apps/api/src/routes/chat.ts` | ~630 | Direct SQL vector similarity on memory_entries | `queryMemory({ userId, workspaceId, queryText })` |
| `packages/agent/src/memory/store.ts` | 394 | Direct SELECT memory_entries | Replaced by query.ts in Phase 4 |

### DELETE

| File | Lines | Reason |
|---|---|---|
| `packages/agent/src/memory/scl.ts:222` | SELECT memory_entries for SCL scoring | Feeds deleted SCL path |
| `packages/agent/src/scl/storage.ts:23-40` | SELECT workspace_mindsets | Deleted with scl package |
| `packages/agent/src/introspection/index.ts:552,612` | SELECT workspace_mindsets | SCL introspection — remove those blocks |
| `apps/api/src/routes/training-data.ts:97-98` | SELECT workspace_mindsets | Remove those rows from table config |

### KEEP — legitimate reads, untouched

All other memory_entries SELECTs (metrics, analytics, browser, mcp-server, streaming-touch, suggest, knn, consolidation, cluster, introspection counts) — these are legitimate and not part of the SCL removal.

---

## 4. Background Job Inventory

### Existing jobs (relevant to memory)

| File | Type | Schedule | Purpose |
|---|---|---|---|
| `apps/api/src/cron/synthesis-nightly.ts` | cron | nightly | Backfill null embeddings, SCL synthesis |
| `apps/api/src/lib/embeddings-reembed.ts` | in-process background | on-demand | Re-embed workspace memories with new model |
| `apps/api/src/federation/event-processor.ts` | event-driven | on event | `memory.push` → storeMemory() |

### Proposed new jobs (Phases 3, 7) — adapted to existing infrastructure

| Proposed Inngest Job | Adapted Form | Location |
|---|---|---|
| `memory/extract-turn` | Async function, fire-and-forget from conversation-bridge | `packages/agent/src/memory/extract-worker.ts` (new) |
| `memory/embed-facts` | Triggered after extract-worker writes facts | Appended to extract-worker, or added to synthesis-nightly |
| `flush-retrieval-counts` | cron every 5 min | Register in `apps/api/src/cron.ts` |
| `decay-confidence` | cron weekly (0 3 * * 0) | Register in `apps/api/src/cron.ts` |

---

## 5. Existing memory_entries Schema (columns to be extended in Phase 1)

Current columns: `id`, `workspace_id`, `type`, `content`, `shorthand`, `metadata`, `tier`, `namespace`, `created_at`
Also present via migration SQL: `embedding vector(?)` — dimension TBD (confirm current dim before Phase 1)

Missing columns (to be added in Phase 1):
`fact_type`, `subject`, `predicate`, `object`, `domain`, `scope_level`, `app_id`, `source_text`, `source`, `superseded_by`, `valid_from`, `invalid_at`, `retrieval_count`, `last_retrieved_at`, `confidence`, `is_anchored`

Missing columns (⚠️ not in plan but needed based on query.ts): `user_id` — add to Phase 1 or scope queries to workspace_id only.

---

## Phase 0 Complete — No code changes made.
