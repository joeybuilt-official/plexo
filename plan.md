# Plexo — Phase 7: Surface Hidden Capabilities

> **2026-05-28.** ADR 0035 accepted. All 5 capabilities have backend code shipped; work is caller/surface wiring only.

---

## Goal

Wire all 5 Phase 7 hidden capabilities into their respective API/CLI/Telegram surfaces so they are observable and usable by the operator.

---

## Session-start ritual

1. `git log --no-pager --no-color -n 5` — verify branch and last commit.
2. Read this file + `checklist.md` (offset/limit, not full read).
3. Read named phase doc or file before writing.

---

## Phases

### Phase 1 — Critical-path API surface
- **Scope:**
  - Add `criticalPath: string[] | null` to `GET /api/sprints/:id` response (gated on `FALKORDB_PLANNER_WAVES=true`). Calls `criticalPathToCompletion(workspaceId, sprint.id)` from `packages/agent/src/planner/cypher-waves.ts:190`.
  - Add Telegram `/criticalpath <sprintId>` command to `apps/api/src/routes/telegram.ts` (after `/start` block, ~line 715). Looks up sprint by id, calls criticalPathToCompletion, sends formatted reply.
- **Deps:** none
- **Subagents:** none (2 files)
- **Exit:** `GET /api/sprints/:id` returns `criticalPath` field when `FALKORDB_PLANNER_WAVES=true`; `null` otherwise. Telegram `/criticalpath` command dispatches correctly.
- **Status:** done

### Phase 2 — Memory-tier badge (confidence field)
- **Scope:**
  - Add `confidence: number | null` to `MemoryEntry` interface (`packages/agent/src/memory/store.ts:36`).
  - Add `confidence` to the SQL SELECT in the semantic search path (`store.ts:434`) and the mapping (`store.ts:448`).
  - Add `confidence` to `GET /api/memory/entries` semantic path response (`apps/api/src/routes/memory.ts:70-80`) and SQL path (`~line 95`).
  - `confidence` is `null` when the column is NULL (before first decay cron run).
- **Deps:** none
- **Subagents:** none (2 files)
- **Exit:** `GET /api/memory/entries` response includes `confidence` field. TypeScript compiles clean.
- **Status:** done

### Phase 3 — Multi-graph cypher CLI
- **Scope:**
  - Create `ops/cypher-cli.ts`. Accepts `--graph <name>` (or `--all-graphs`), `--cypher <query>`. Posts to sidecar `/v1/graph/cypher` with HMAC (same as graphiti-bridge).
  - Read-only guard: reject queries containing `CREATE`, `DELETE`, `MERGE`, `SET`, `REMOVE` keywords (case-insensitive).
  - Reads `PLEXO_GRAPHITI_SIDECAR_URL` + `PLEXO_SERVICE_KEY` from env (no flags needed for auth).
  - `--all-graphs` iterates graph names from sidecar `/v1/schema/registry` and runs the query against each.
- **Deps:** none
- **Subagents:** none (1 file)
- **Exit:** `npx ts-node ops/cypher-cli.ts --graph plexo:test --cypher "MATCH (n) RETURN count(n)"` executes and returns results. Write query is rejected with clear error.
- **Status:** done

### Phase 4 — Confidence-decay heatmap
- **Scope:**
  - Migration `0120_memory_tier_stats.sql` — creates `memory_tier_stats(workspace_id, tier, confidence_band, count, last_decay_at)`. Confidence band = 0-20, 20-40, 40-60, 60-80, 80-100 as enum or varchar check.
  - `apps/api/src/cron/confidence-lifecycle.ts` — after the decay UPDATE, upsert into `memory_tier_stats` per workspace.
  - `apps/api/src/routes/memory.ts` — add `GET /api/memory/heatmap?workspaceId=`. Reads `memory_tier_stats` for workspace; returns `{ buckets, lastUpdated }`. Returns `{ buckets: [], lastUpdated: null }` if no stats yet.
  - `apps/api/src/routes/telegram.ts` — add `/memoryheatmap` command. Calls the heatmap query directly (no HTTP round-trip) and sends a text summary.
- **Deps:** none (migration is new table; no lock on existing)
- **Subagents:** none
- **Exit:** Migration applies clean. `GET /api/memory/heatmap` returns bucket data. Telegram `/memoryheatmap` command sends a formatted reply.
- **Status:** done

### Phase 5 — Triplet fast-path adoption
- **Scope:**
  - Add `addTriplet(req: TripletCreate): Promise<TripletResult | null>` to `packages/graphiti-bridge/src/index.ts` (mirrors `addEpisode` pattern, posts to `/v1/triplets`).
  - Add `PLEXO_TRIPLET_FAST_PATH` env flag. When `true`, `scripts/migrate-corpus-to-graphiti.ts` and any future bulk-write callers route through `addTriplet`.
  - Add a `TripletCreate` / `TripletResult` type to the bridge's public API.
  - Conversational path (`addEpisode`) is NOT touched.
- **Deps:** none
- **Subagents:** none (2 files)
- **Exit:** `addTriplet` method exists in graphiti-bridge, TypeScript compiles, corpus migration script respects `PLEXO_TRIPLET_FAST_PATH=true`.
- **Status:** done

---

## One-way doors ⚠

None in this plan. All changes are additive (new fields nullable, new endpoints, new ops script, new migration for a new table).

## Operator sign-off gates

- **Gate-final** (after Phase 5): operator tests `/criticalpath`, `/memoryheatmap` on the host and confirms capability is visible end-to-end.

---

## Key file map (for fast session resume)

| Cap | Key file(s) |
|-----|------------|
| 1 — Critical path | `packages/agent/src/planner/cypher-waves.ts:190`, `apps/api/src/routes/sprints.ts:138`, `apps/api/src/routes/telegram.ts:701` |
| 2 — Memory-tier badge | `packages/agent/src/memory/store.ts:36,434,448`, `apps/api/src/routes/memory.ts:70,95` |
| 3 — Multi-graph CLI | `ops/cypher-cli.ts` (new), `packages/graphiti-bridge/src/index.ts` (HMAC pattern ref) |
| 4 — Decay heatmap | `packages/db/drizzle/0120_memory_tier_stats.sql` (new), `apps/api/src/cron/confidence-lifecycle.ts`, `apps/api/src/routes/memory.ts`, `apps/api/src/routes/telegram.ts` |
| 5 — Triplet fast-path | `packages/graphiti-bridge/src/index.ts`, `scripts/migrate-corpus-to-graphiti.ts` |

---

## Decisions log

- 2026-05-28 — Plan drafted. ADR 0035 accepted. All 5 expert-panel conflicts resolved inline (see ADR).

## Deviations log

_(empty)_
