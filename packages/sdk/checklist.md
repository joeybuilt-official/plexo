# SDK rollout — checklist

## Phase 1 — App-starter cleanup

- [x] Drop Playwright from `/home/dustin/dev/joeybuilt/app-starter/next-session.txt`
- [x] Drop Playwright references from app-starter checklist.md + plan.md
- [x] Generate Drizzle migration (`drizzle/0000_grey_morlocks.sql`) — first migration, covers all 7 tables
- [x] Review generated migration SQL — clean, schema "app", all 7 tables incl audit_log + notification_log
- [n/a] ⚠ prod push gate — app-starter is template-only, no live prod DB for it; migration ships in template for per-app deployment to apply on first run
- [x] Commit migration file to app-starter

## Phase 2 — Plexo Core endpoint audit ✅

- [x] Inventory `/api/v1/...` routes — 18 domains, all standard
- [x] Read `@pushd/plexo-client` (cloned to `/home/dustin/dev/joeybuilt/pushd/packages/plexo-client/`)
- [x] Map each helper — 10 helpers call phantom endpoints that don't exist in Core
- [x] ⚠ Escalated to operator → **Path B chosen** (generic `aiComplete` + deploy prompts; no Core changes)

## Phase 3 — Fonto swap ✅ (commit `9432a32` in fonto)

- [x] Clone fonto to `/home/dustin/dev/joeybuilt/fonto`
- [x] `pnpm add @joeybuilt/plexo-sdk@^0.3.0` (later bumped to ^0.4.0)
- [x] Rewrite `lib/plexo.ts` using SDK (236 → 134 lines)
- [x] Rewrite `lib/plexo-registration.ts` using SDK (96 → 53 lines)
- [x] Preserve fonto-specific helpers (`plexoClassifyAsset`, `plexoSuggestTags`, `plexoDescribeImage`)
- [x] Typecheck clean
- [x] SDK bumped to 0.3.0 — added `publishEvent`, `storeMemory`, `searchMemory`, `visionOcr`
- [x] Re-pinned all consumers
- [x] Commit fonto

## Phase 4 — Nexalog swap ✅ (commit `7ef71c0` in nexalog)

- [x] Clone nexalog to `/home/dustin/dev/joeybuilt/nexalog`
- [x] `pnpm add @joeybuilt/plexo-sdk@^0.4.0`
- [x] Rewrite `lib/plexo.ts` (257 → 173 lines) + `lib/plexo-registration.ts` (98 → 65 lines)
- [x] Preserve nexalog-specific helpers (`plexoSuggestTitle`)
- [x] SCL helpers preserved as raw-fetch wrappers w/ TODO (Core endpoints don't exist)
- [x] Typecheck clean
- [x] SDK bumped to 0.4.0 — added `getConversations`
- [x] Re-pinned all consumers (app-starter `fc88200`, levio `98b0fe2`, fonto `49b0d0e`)
- [x] Commit nexalog

## Phase 5 — Pushd refactor

- [ ] Clone pushd to `/home/dustin/dev/joeybuilt/pushd`
- [ ] Inventory every export from `@pushd/plexo-client`
- [ ] Map every import site of `@pushd/plexo-client` across pushd
- [ ] Create `apps/web/src/lib/plexo-deploy/` directory
- [ ] Move each helper to its own file under `plexo-deploy/`
- [ ] Each helper uses `plexo` from `apps/web/src/lib/plexo.ts` (SDK init)
- [ ] Rewrite `apps/web/src/lib/plexo.ts` as 5-line SDK init
- [ ] Update import sites: `@pushd/plexo-client` → `@/lib/plexo-deploy/<helper>`
- [ ] Typecheck pushd workspaces
- [ ] ⚠ Operator gate: staging parity verification
- [ ] Delete `packages/plexo-client/` (one-way door)
- [ ] Remove from `pnpm-workspace.yaml`
- [ ] Re-typecheck
- [ ] Bump SDK if gaps surfaced (final lock)
- [ ] Commit + push pushd

## Phase 6 — SDK 1.0.0 + handoff

- [ ] Confirm all consumers on same SDK version + typecheck clean
- [ ] Bump SDK to 1.0.0
- [ ] Refresh quick-start in `src/connect/index.ts`
- [ ] Run `pnpm publish`
- [ ] Bump every consumer to ^1.0.0
- [ ] Update memories (SDK rollout complete + final version + consumer list)
- [ ] Final `next-session.txt` handoff
