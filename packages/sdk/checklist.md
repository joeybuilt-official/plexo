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

## Phase 5 — Pushd refactor ✅ (commits `06ef212` swap + `af5f0a8` deletion)

- [x] Clone pushd to `/home/dustin/dev/joeybuilt/pushd`
- [x] Inventory exports from `@pushd/plexo-client` (12 methods, 14 types) via Explore subagent
- [x] Map import sites — only 3 (singleton holders); 6 helpers actively used, 6 dead
- [x] Create `apps/web/src/lib/plexo-deploy/` w/ types, parse-json, 4 active helpers
- [x] Each helper uses SDK `plexo.aiComplete()` w/ deploy-shaped prompt (Path B)
- [x] Rewrite `apps/web/src/lib/plexo.ts` as 5-line SDK init
- [x] Update import sites (deployer.ts, monitoring.ts, 3 API routes)
- [x] Typecheck clean across changed files
- [x] ⚠ Gate 2 — operator confirmed deletion
- [x] Delete `packages/plexo-client/` entirely (one-way door)
- [x] Update `apps/web/next.config.ts` (drop transpilePackages entry)
- [x] Drop 6 dead helpers (suggestEnvVars, generateChangelog, validateApiKey, buildFromDescription, getBuildStatus, applyChange) — never called
- [x] Commit pushd

## Phase 6 — SDK 1.0.0 + handoff ✅

- [x] All consumers on ^0.4.0, typecheck clean
- [x] Bump SDK to 1.0.0 + publish
- [x] Quick-start in `src/connect/index.ts` reviewed, no drift
- [x] Re-pin every consumer to ^1.0.0 (app-starter `a641185`, levio `ac0e890`, fonto `3275fd1`, nexalog clean, pushd `74d1910`)
- [x] Memory written: `plexo-sdk.md` (consumers + version + ADR pointer)
- [x] Final handoff written
