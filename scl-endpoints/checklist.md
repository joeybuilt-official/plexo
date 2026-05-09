# Checklist — SCL endpoints rollout

Flat ordered steps, derived from `plan.md`. Tick as completed.

## Phase 1 — Plexo Core
- [x] Add `packages/agent/src/memory/scl-query.ts` w/ `mutateConceptGraph` (row-locked, append-only jsonb merge)
- [x] Add `expandConceptGraph` (substring match MVP; depth/width capped, `truncated` flag)
- [x] Add `getGoldenRecordMeta` (read `mindset_object`)
- [x] Add `triggerSclExtract` (log + 200; real extract is cron-driven via `evaluateSclPromotion`)
- [x] Add `apps/api/src/routes/scl.ts` w/ POST /mutate, POST /expand, GET /record/meta, POST /extract/trigger
- [x] Service-key auth inside router (match synthesis/themes pattern)
- [x] Mount router: `v1.use('/scl', sclRouter)` in `apps/api/src/index.ts:325`
- [x] Add `apps/api/src/__tests__/scl-routes.test.ts` — 13 tests (auth + validation + happy)
- [x] Add `./memory/scl-query` exports to `packages/agent/package.json` + `vitest.config.ts` alias
- [x] `pnpm -C apps/api typecheck` clean (3 pre-existing deepgram/telegram errors unrelated)
- [x] `pnpm vitest run apps/api/src/__tests__/scl-routes.test.ts` → 13/13 pass
- [x] ⚠ Operator gate confirmed (2026-05-09): service-key auth + 4 endpoints + phasing
- [x] Commit Phase 1
- [ ] Manual curl smoke: 401 without service key, 200 with valid payload (defer to staging)
- [ ] Push to plexo origin (operator authorize — auto-deploy on push)
- [ ] Plexo Core deployed to VPS

## Phase 2 — SDK 1.1.0
- [ ] Add `sclMutate(workspaceId, concepts, source): Promise<void>` to `PlexoClient`
- [ ] Add `sclExpand(workspaceId, stimulus, opts?): Promise<{nodes, truncated}>`
- [ ] Add `sclRecordMeta(workspaceId): Promise<GoldenRecordMeta | null>`
- [ ] Add `sclExtractTrigger(workspaceId, sourceLogId?): Promise<void>`
- [ ] Co-locate types in `packages/sdk/src/types/`
- [ ] Bump `packages/sdk/package.json` → `1.1.0`
- [ ] `pnpm -C packages/sdk build` clean
- [ ] `pnpm -C packages/sdk typecheck` clean
- [ ] Local `pnpm pack` + dry-run install in nexalog → typecheck clean
- [ ] ⚠ Operator gate: approve `npm publish`
- [ ] `npm publish @joeybuilt/plexo-sdk@1.1.0`
- [ ] Verify on npm registry

## Phase 3 — Nexalog swap
- [ ] Replace `plexoSclMutate` body in `lib/plexo.ts:103` → `client.sclMutate(...)`
- [ ] Replace `plexoSclExpand` body in `lib/plexo.ts:125` → `client.sclExpand(...)`
- [ ] Replace `plexoGoldenRecordMeta` body in `lib/plexo.ts:163` → `client.sclRecordMeta(...)`
- [ ] Replace inline fetch in `lib/enrichment/embeddings.ts:375` → `client.sclExtractTrigger(...)`
- [ ] Bump pin: `nexalog/package.json` → `"@joeybuilt/plexo-sdk": "^1.1.0"`
- [ ] `pnpm install`
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` no regression
- [ ] Verify 5 call-sites unchanged externally:
  - [ ] `app/api/capture/route.ts:130`
  - [ ] `app/api/plexo/scl-nodes/route.ts:36`
  - [ ] `app/api/notes/[id]/route.ts:51`
  - [ ] `app/api/notes/route.ts:47`
  - [ ] `lib/auto-categorize.ts:92`
- [ ] ⚠ Operator gate: approve push (auto-deploy on push)
- [ ] Commit + push nexalog to origin

## Phase 4 — Smoke + close-out
- [ ] Tail nexalog + plexo-api logs 5 min after deploy
- [ ] No `scl/*` 404s in logs
- [ ] No `scl/*` 401s in logs
- [ ] At least one successful `scl/mutate` from a real capture observed
- [ ] Update `/home/dustin/dev/joeybuilt/plexo/packages/sdk/plan.md` open-items: SCL gap → resolved
- [ ] Update `/home/dustin/dev/joeybuilt/plexo/adr/0006-sdk-rollout-strategy.md` follow-ups: SCL gap → resolved
- [ ] Commit doc updates to plexo origin
