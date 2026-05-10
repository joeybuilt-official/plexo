# Plan — SCL removal + graph-layer replacement

**Status:** SUPERSEDED 2026-05-09. Concept-graph trajectory abandoned in favor of wholesale Graphiti adoption (see `/home/dustin/dev/joeybuilt/plexo/adr/0010-graphiti-adoption.md` and `/home/dustin/dev/joeybuilt/plexo/graphiti-migration/plan.md`). Phases 2 + 3 of this plan were reverted on `plexo/main` (commits `9032efb3` + `843fec76`); reference branch `pre-graphiti-concept-graph` preserves the original work. Phase 1 (SCL revert) and Phase 4 partial (JSDoc + marketing SCL leftovers, commit `f53e4076`) remain on main as orthogonal SCL cleanup that survives the Graphiti pivot.

**Goal (original — historical):** Reverse the just-shipped (un-pushed) SCL endpoints rollout, replace it with a minimal in-house graph layer atop existing pgvector + memory_entries, complete the May-1 SCL removal leftovers, and cut nexalog over to the new layer in a single coordinated SDK 1.1.0 publish.

**Related docs:**
- `/home/dustin/dev/joeybuilt/plexo/adr/0009-scl-removal-and-graph-replacement.md` — this ADR
- `/home/dustin/dev/joeybuilt/plexo/docs/cleanup-audit-scl-remnants.txt` — May-1 removal audit (most leftovers already cleaned per Phase 1 pin; 5 remain for Phase 4)
- `/home/dustin/dev/joeybuilt/plexo/packages/db/src/schema.ts` — graph schema target

**Deleted by Phase 1 revert (preserved in git history):**
- `adr/0008-scl-endpoints.md` (committed in 21360f64; reverted in 29006185)
- `scl-endpoints/{plan,checklist}.md` (same)

## Phases

### Phase 1 — State pin + Wave B revert
- **Scope:**
  - Explore subagent: pin every Wave A leftover from `cleanup-audit-scl-remnants.txt` Section 1 against current HEAD; confirm files still match line numbers (audit was 8 days old). Output ≤300 words: file:line list, ready for batch edit. Verify nexalog still uses raw fetch (no SDK 1.1.0 dep yet).
  - Git revert (or `git reset --soft` + selective re-add) the two Wave B commits on `plexo/main`:
    - `21360f64 feat(api): SCL endpoints (ADR 0008) — Phase 1 server-side`
    - `7150987c feat(sdk): @joeybuilt/plexo-sdk@1.1.0 — SCL methods (ADR 0008)`
  - Decision: keep `graph_json` schema column (drops in Phase 4 with `mindset_object`).
  - Delete `apps/api/src/routes/scl.ts`, `packages/agent/src/memory/scl-query.ts`, SCL test file, the SCL types co-added in `packages/sdk/src/types/`.
  - Restore SDK `package.json` version to `1.0.0`.
- **Deps:** none
- **Context budget:** ≤15%
- **Subagents:** Explore (state pin only)
- **Exit:**
  - `git log -n 5` no longer shows the two Wave B SHAs.
  - `pnpm -C apps/api typecheck` clean (any pre-existing failures noted, not regressions).
  - `pnpm -C packages/sdk typecheck` clean.
- **Status:** pending

### Phase 2 — Graph schema + linker (data layer)
- **Scope:**
  - Drizzle migration: `concept_nodes`, `concept_edges`, `concept_membership` per ADR 0009. pgvector extension already enabled. Indexes: `(workspace_id, label)` on nodes; `(workspace_id, src_node_id)` and `(workspace_id, dst_node_id)` on edges; `(memory_entry_id)` on membership.
  - New module `packages/agent/src/memory/graph-query.ts`:
    - `graphMutate(workspaceId, concepts, source)` — upsert nodes + membership; light edge inference via cosine over node embeddings (threshold ≥ 0.85, capped at 5 edges per new node).
    - `graphExpand(workspaceId, stimulus, opts?)` — recursive CTE BFS with depth/width caps (defaults 2/50, max 4/200, `truncated` flag, `SET LOCAL statement_timeout = 2s`).
    - `getGraphMeta(workspaceId)` — counts + last_update.
    - `triggerGraphExtract(workspaceId, sourceLogId?)` — heartbeat for now (real linker enqueue Phase 6 follow-up if needed).
  - Linker hookup: extend the existing memory-extraction worker to emit graph mutations after each batch of facts. Reuse `embedText` from existing pipeline.
  - Tests: `packages/agent/src/__tests__/graph-query.test.ts` covering happy mutate, expand BFS truncation, meta empty/populated, extract heartbeat.
- **Deps:** Phase 1 clean
- **Context budget:** ≤30%
- **Subagents:** general-purpose for the migration + module + tests (write-heavy; main context stays clean for review).
- **Exit:**
  - Migration applies cleanly to dev DB (`pnpm -C apps/api db:migrate` or equivalent script).
  - `pnpm -C apps/api typecheck` clean.
  - `pnpm -C packages/agent test` passes new tests.
- **Gate:** ⚠ Operator gate before migration commit lands on `main`.
- **Status:** pending

### Phase 3 — Graph endpoints + SDK 1.1.0 (graph methods)
- **Scope:**
  - `apps/api/src/routes/graph.ts` — 4 endpoints under `/api/v1/graph/*` per ADR 0009. Service-key auth in router (mirrors synthesis/themes). Mount `v1.use('/graph', graphRouter)` adjacent to synthesis/themes in `apps/api/src/index.ts`.
  - `apps/api/src/__tests__/graph-routes.test.ts` — happy path + auth-fail per route (4 routes × 2 cases).
  - SDK additions in `packages/sdk/src/connect/client.ts`: `graphMutate`, `graphExpand`, `graphMeta`, `graphExtractTrigger`. Co-located types in `packages/sdk/src/types/`.
  - Bump `packages/sdk/package.json` → `1.1.0`. Update CHANGELOG.
  - `pnpm -C packages/sdk build && pnpm -C packages/sdk typecheck`.
- **Deps:** Phase 2 merged
- **Context budget:** ≤25%
- **Subagents:** general-purpose if route + test scaffolding balloons; otherwise direct edit.
- **Exit:**
  - `pnpm -C apps/api typecheck` + `pnpm -C apps/api test` clean.
  - SDK build + typecheck clean.
  - `npm publish --dry-run` clean from `packages/sdk`.
- **Status:** pending

### Phase 4 — Wave A leftover cleanup + column drops
- **Scope (delegate to general-purpose subagent — multi-file batch):**
  - Remove `sclStats` field from `packages/agent/src/behavior/reflect.ts:54-56`.
  - Remove `if (reflectResult.track === 'scl' && reflectResult.sclStats)` branch from `apps/api/src/agent-loop.ts:1032-1042`.
  - Remove `attractorsRefined`/`attractorsCreated`/`attractorLabel` fields + emitters from `apps/api/src/analytics/events.ts:556-575`.
  - Remove `attractorIds` param from `packages/agent/src/domain-mastery/index.ts:65-87` (update hash + all call-sites).
  - Update JSDoc removing attractor mentions: `packages/agent/src/behavior/types.ts:66`, `packages/db/src/schema.ts:634,657`.
  - Delete stale comment `apps/api/src/lib/embeddings-reembed.ts:253-254`.
  - Replace stale system prompts:
    - `packages/agent/src/memory/store.ts:166` SHORTHAND_SYSTEM_PROMPT → atomic-fact aligned.
    - `apps/api/src/routes/training-data.ts:290` system prompt → atomic-fact aligned.
  - Remove "Drift Detection" feature card from `apps/web/src/app/page.tsx:357`.
  - Remove stale comment `apps/web/src/app/app/settings/intelligence/layout.tsx:24`.
  - Remove or repoint stale assertion `tests/integration/workspace-isolation-security.test.ts:44`.
  - Drizzle migration: drop `mindset_object` jsonb column from workspaces (`packages/db/src/schema.ts:1686`); drop `graph_json` jsonb column (`schema.ts:1685`) — same migration, idempotent.
  - Update `docs/memory.md` — rewrite SCL/MindsetObject sections to atomic-fact + graph-layer terms.
- **Deps:** Phase 3 merged (so docs can cite the new graph endpoints)
- **Context budget:** ≤20% (subagent does the work; main context reviews diff)
- **Subagents:** general-purpose, single dispatch with the full file:line list from Phase 1 pin.
- **Exit:**
  - `pnpm -C apps/api typecheck` clean.
  - `pnpm -C packages/agent test` clean.
  - Migration applies cleanly to dev DB.
  - No grep hits for: `sclStats`, `attractorsRefined`, `attractorsCreated`, `attractorLabel`, `MindsetObject`, `mindset_object`, `graph_json` (outside of migration history).
- **Gate:** ⚠ Operator gate before column-drop migration commits.
- **Status:** pending

### Phase 5 — Nexalog cutover
- **Scope:**
  - In nexalog repo (`/home/dustin/dev/joeybuilt/nexalog`):
    - `lib/plexo.ts` lines 99–180 — replace `plexoSclMutate` → `client.graphMutate`, `plexoSclExpand` → `client.graphExpand`, `plexoGoldenRecordMeta` → `client.graphMeta`. Rename internal exports SCL→graph for clarity.
    - `lib/enrichment/embeddings.ts:375` — replace inline fetch with `client.graphExtractTrigger(...)`.
    - 5 call-sites unchanged externally (rename internal):
      - `app/api/capture/route.ts:130`
      - `app/api/plexo/scl-nodes/route.ts:36` (consider renaming route to `graph-nodes`; deferred — not in this phase)
      - `app/api/notes/[id]/route.ts:51`
      - `app/api/notes/route.ts:47`
      - `lib/auto-categorize.ts:92`
    - Bump `nexalog/package.json` → `"@joeybuilt/plexo-sdk": "^1.1.0"`. `pnpm install`.
  - `pnpm -C /home/dustin/dev/joeybuilt/nexalog typecheck` + `pnpm test` clean.
- **Deps:** Phase 6 SDK published (sequencing note: this phase technically blocks on Phase 6 npm publish)
- **Context budget:** ≤10%
- **Subagents:** none
- **Exit:**
  - Nexalog typecheck + test clean.
  - Manual smoke: capture a note in dev → confirm 200 from `/api/v1/graph/mutate` in API logs.
- **Gate:** ⚠ Operator gate before nexalog `git push` (auto-deploy daemon).
- **Status:** pending

### Phase 6 — Publish + closeout
- **Scope:**
  - SDK publish:
    - `cd packages/sdk && npm publish` (1.1.0 with graph methods).
    - Verify via `npm view @joeybuilt/plexo-sdk version` → `1.1.0`.
  - Plexo push:
    - `git push origin main` from plexo repo (auto-deploy daemon picks up; Phases 2 + 3 + 4 commits go live).
    - Tail plexo-api logs 5 min: confirm no `scl/*` 404s/401s, at least one successful `graph/mutate` from a real capture (after nexalog deploys in Phase 5).
  - Nexalog push (sequenced after SDK publish):
    - Bump pin (Phase 5), commit, `git push origin main`.
  - Doc closeouts:
    - Mark `/home/dustin/dev/joeybuilt/plexo/scl-endpoints/plan.md` **SUPERSEDED — see ADR 0009** at top.
    - Append "Superseded by ADR 0009" to top of `adr/0008-scl-endpoints.md`.
    - Update `adr/0006-sdk-rollout-strategy.md` follow-ups list — mark "SCL endpoints" entry as resolved via ADR 0009.
    - Append closeout note to `docs/cleanup-audit-scl-remnants.txt` with ADR 0009 reference and dates.
- **Deps:** Phases 1–5 merged
- **Context budget:** ≤10%
- **Subagents:** none
- **Exit:**
  - SDK 1.1.0 visible on npm registry.
  - Plexo prod logs clean post-deploy.
  - Nexalog prod uses graph endpoints with no errors over 24h.
  - Audit doc + ADRs reflect current state.
- **Gate:** ⚠ npm publish + plexo push + nexalog push are each separate operator gates.
- **Status:** pending

## One-way doors

- ⚠ **Phase 6 `npm publish @joeybuilt/plexo-sdk@1.1.0`** — irreversible. Operator gate.
- ⚠ **Phase 4 column-drop migration** — irreversible. Operator gate before commit.
- ⚠ **Phase 6 plexo `git push origin main`** — auto-deploy daemon picks up. Operator gate.
- ⚠ **Phase 6 nexalog `git push origin main`** — auto-deploy daemon. Operator gate.

## Operator sign-off gates

1. Phase 2 — review `concept_nodes`/`concept_edges`/`concept_membership` schema before migration commits.
2. Phase 4 — review `mindset_object` + `graph_json` column-drop migration.
3. Phase 5 — confirm nexalog rename SCL→graph internally (vs minimal external-rename only).
4. Phase 6 — three separate gates: SDK publish, plexo push, nexalog push.

## Surfaced panel conflicts (operator decision needed)

1. **Typed edges at v0.1?** — recommend NO (free-text `relation` column).
2. **Async-via-Inngest graph mutate?** — recommend NO (sync upsert; revisit on latency).
3. **Drop `graph_json` column in Phase 4?** — recommend YES (no live consumer; new tables are source of truth).

## Out of scope

- Nexalog route rename `scl-nodes` → `graph-nodes` (cosmetic; defer).
- ADR 0006 duplicate-numbering fix (`0006-inngest-install.md` + `0006-sdk-rollout-strategy.md`) — separate cleanup.
- Real linker async-via-Inngest enqueue.
- Edge typing, temporal graph features.
- Graph-DB sidecar evaluation (settled in OSS benchmark; revisit if scale demands).
