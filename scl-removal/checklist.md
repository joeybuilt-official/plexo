# Checklist — SCL removal + graph-layer replacement

Flat ordered steps, derived from `plan.md`. Tick as completed.

## Phase 1 — State pin + Wave B revert ✅ done 2026-05-09
- [x] Explore subagent: pinned Wave A leftovers — only 5 items remain (most already cleaned by prior sessions)
- [x] Confirmed nexalog has no SDK 1.1.0 dep yet (still ^1.0.0; `lib/plexo.ts` raw-fetch wrappers at :103/:125/:163)
- [x] Reverted plexo commit `21360f64` (apps/api SCL routes) — new SHA `29006185`
- [x] Reverted plexo commit `7150987c` (SDK 1.1.0 SCL methods) — new SHA `c53b6059`
- [x] Verified deletions: `apps/api/src/routes/scl.ts` GONE; `packages/agent/src/memory/scl-query.ts` GONE; `apps/api/src/__tests__/scl-routes.test.ts` GONE
- [x] **Side effect:** revert also removed `adr/0008-scl-endpoints.md` + `scl-endpoints/{plan,checklist}.md` (they were added in commit 21360f64). Phase 6 closeout steps for those files become moot — updated below.
- [x] SDK `package.json` reset to `1.0.0` (verified)
- [x] `pnpm -C packages/sdk typecheck` clean
- [x] `pnpm -C apps/api typecheck` shows only the 3 pre-existing Buffer/BlobPart errors (deepgram.ts:577, telegram.ts:239) flagged as not-introduced-by-SCL in original Wave B plan — not regressions
- [x] Revert commits already on `main` (auto-committed by `git revert`); not pushed

**Remaining Phase 4 items (after pin):**
- `packages/agent/src/behavior/types.ts:66` JSDoc cleanup
- `packages/db/src/schema.ts:750` JSDoc cleanup (audit said :634/:657; only one survived after prior cleanups)
- `apps/web/src/app/page.tsx:358` Drift Detection card removal
- `packages/db/src/schema.ts:1685-1686` drop `graph_json` + `mindset_object` columns
- `docs/memory.md` rewrite (SCL/MindsetObject sections)

Phase 4 is now small enough to do directly in main context — no subagent needed.

## Phase 2 — Graph schema + linker ✅ done 2026-05-09
- [x] Drizzle schema additions: `concept_nodes`, `concept_edges`, `concept_membership` w/ indexes per ADR 0009 — `packages/db/src/schema.ts:2014-2086`
- [x] Migration **hand-authored** (drizzle-kit `db:generate` broken on this project — snapshot meta stops at 0023, migrations through 0117 — known journal-skip-cursor gotcha): `packages/db/drizzle/0118_concept_graph_phase_1.sql` (idempotent CREATE IF NOT EXISTS + HNSW vector index)
- [x] ⚠ Operator gate: schema + migration approved 2026-05-09 ("Proceed.")
- [ ] **Apply migration to dev DB** — DEFERRED to operator: project's drizzle-kit migrate is unsafe given journal desync. Operator chooses runner (manual psql apply or hand-insert tracking row).
- [x] `packages/agent/src/memory/graph-query.ts` — graphMutate, graphExpand, getGraphMeta, triggerGraphExtract
- [x] Recursive CTE BFS w/ depth/width caps + `SET LOCAL statement_timeout = 2s` + `truncated` flag
- [x] Linker hookup in `packages/agent/src/memory/extract-worker.ts:130-138` — calls graphMutate after each fact persist (fire-and-forget, non-fatal)
- [x] Tests: `packages/agent/src/memory/__tests__/graph-query.test.ts` — 11 tests passing (mutate happy/empty/embed-fail/existing, expand empty/embed-fail/within-cap/truncated, meta empty/populated, trigger heartbeat)
- [x] `pnpm -C packages/agent typecheck` exit 0
- [x] `pnpm -C packages/agent test` — 11/11 graph-query tests pass; 10 pre-existing failures in unrelated files (namespace.test.ts, build-memory-block.test.ts) — not regressions
- [ ] Commit Phase 2 on `main` (next)

## Phase 3 — Graph endpoints + SDK 1.1.0
- [ ] `apps/api/src/routes/graph.ts` — 4 endpoints under `/api/v1/graph/*`
- [ ] Service-key auth in router (mirrors synthesis/themes)
- [ ] Mount `v1.use('/graph', graphRouter)` in `apps/api/src/index.ts`
- [ ] `apps/api/src/__tests__/graph-routes.test.ts` — happy + auth-fail per route (8 tests)
- [ ] SDK methods in `packages/sdk/src/connect/client.ts`: `graphMutate`, `graphExpand`, `graphMeta`, `graphExtractTrigger`
- [ ] SDK types in `packages/sdk/src/types/`
- [ ] Bump `packages/sdk/package.json` → `1.1.0`
- [ ] Update SDK CHANGELOG (or create) — note SCL→graph rename, never-published 1.1.0 SCL preview
- [ ] `pnpm -C packages/sdk build` clean
- [ ] `pnpm -C packages/sdk typecheck` clean
- [ ] `pnpm -C apps/api typecheck + test` clean
- [ ] `npm publish --dry-run` clean from `packages/sdk`
- [ ] Commit Phase 3 on `main`

## Phase 4 — Wave A leftover cleanup + column drops (trimmed after Phase 1 pin)
- [x] `packages/agent/src/behavior/types.ts:66` — removed "attractor IDs in prompt" from JSDoc
- [x] `packages/db/src/schema.ts:750` — removed "attractor IDs" from JSDoc on Domain mastery column
- [x] `apps/web/src/app/page.tsx:358` — removed "Drift Detection" feature card
- [ ] **Discovery — schema location was wrong in plan.** `graph_json` + `mindset_object` are on `scl_concept_graphs` table (`packages/db/src/schema.ts:1680-1693`), NOT `workspaces` as plan said. The whole `scl_concept_graphs` table is leftover SCL infrastructure with active consumers:
   - `apps/api/src/lib/embeddings-reembed.ts:255-265` — UPDATEs `graph_json`
   - `apps/api/src/lib/embeddings-reembed.ts:349-353` — SELECTs `graph_json`
   - `apps/api/src/routes/training-data.ts` — fixture handler for table
   - 2 test files reference it
   ⚠ **Operator gate — scope decision needed before column-drop migration.** Three options:
   - **A: Drop the entire `scl_concept_graphs` table** + delete the SCL re-embed branch + training-data handler (~80 LOC). Cleanest end state.
   - **B: Drop just the two jsonb columns** + neuter the SCL re-embed branch to no-op. Smaller diff; table shell remains.
   - **C: Defer column drops.** Ship Phase 4 JSDoc + marketing only. Schedule follow-up after operator reviews consumer surface.
- [ ] Apply chosen migration to dev DB (after operator decision)
- [ ] `docs/memory.md` rewrite — atomic-fact + graph-layer language (deferred until scope decision lands)
- [ ] Final sweep: grep no hits for `MindsetObject|mindset_object|graph_json|attractor` outside migration history + ADR 0009 + this checklist + ops/historical analysis dirs
- [ ] `pnpm -C apps/api typecheck` no NEW errors (Buffer/BlobPart pre-existing OK)
- [ ] `pnpm -C packages/agent test` clean
- [ ] Commit Phase 4 on `main` — partial (JSDoc + marketing) committed; column-drop pending operator scope decision

## Phase 5 — Nexalog cutover
- [ ] `nexalog/lib/plexo.ts:99-180` — swap raw fetch → SDK calls; rename SCL→graph internally
- [ ] `nexalog/lib/enrichment/embeddings.ts:375` — swap to `client.graphExtractTrigger`
- [ ] Verify 5 call-sites compile w/ rename:
  - [ ] `app/api/capture/route.ts:130`
  - [ ] `app/api/plexo/scl-nodes/route.ts:36`
  - [ ] `app/api/notes/[id]/route.ts:51`
  - [ ] `app/api/notes/route.ts:47`
  - [ ] `lib/auto-categorize.ts:92`
- [ ] Bump `nexalog/package.json` → `"@joeybuilt/plexo-sdk": "^1.1.0"`; `pnpm install`
- [ ] `pnpm -C /home/dustin/dev/joeybuilt/nexalog typecheck` clean
- [ ] `pnpm -C /home/dustin/dev/joeybuilt/nexalog test` clean
- [ ] Manual smoke (dev): capture a note → confirm 200 from `/api/v1/graph/mutate` in API logs
- [ ] Commit nexalog locally; do NOT push yet (gated in Phase 6)

## Phase 6 — Publish + closeout
- [ ] ⚠ Operator gate: SDK publish authorization
- [ ] `cd packages/sdk && npm publish`
- [ ] `npm view @joeybuilt/plexo-sdk version` → `1.1.0`
- [ ] ⚠ Operator gate: plexo push authorization
- [ ] `git push origin main` from plexo (auto-deploy)
- [ ] Tail plexo-api logs 5 min — no `scl/*` 404s/401s
- [ ] ⚠ Operator gate: nexalog push authorization
- [ ] `git push origin main` from nexalog (auto-deploy)
- [ ] Confirm at least one successful `graph/mutate` from real nexalog capture in prod
- [ ] ~~Mark `plexo/scl-endpoints/plan.md` SUPERSEDED~~ — file deleted by Phase 1 revert (moot)
- [ ] ~~Append "Superseded by ADR 0009" pointer to `adr/0008-scl-endpoints.md`~~ — file deleted by Phase 1 revert (moot; git history preserves it)
- [ ] Update `adr/0006-sdk-rollout-strategy.md` follow-ups: SCL entry resolved via ADR 0009
- [ ] Append closeout to `docs/cleanup-audit-scl-remnants.txt` w/ ADR 0009 ref + 2026-05-09 date
- [ ] 24h prod observation — no nexalog graph errors
- [ ] Commit closeout docs on `main`; push (no further gates — docs only)

## Wrap-up
- [ ] Update memory: graph-layer replaces SCL across plexo + nexalog
- [ ] Final next-session.txt notes any deferred follow-ups (typed edges, async mutate, real linker enqueue)
