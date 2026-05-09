# SDK rollout — master plan

**Goal:** finish remaining app-starter v3 items and bring `@joeybuilt/plexo-sdk` to
feature-complete coverage of every Joeybuilt VPS app that talks to Plexo, then ship 1.0.

**ADR:** `/home/dustin/dev/joeybuilt/plexo/adr/0006-sdk-rollout-strategy.md`
**Files:**
- this plan: `/home/dustin/dev/joeybuilt/plexo/packages/sdk/plan.md`
- checklist: `/home/dustin/dev/joeybuilt/plexo/packages/sdk/checklist.md`
- handoff: `/home/dustin/dev/joeybuilt/plexo/packages/sdk/next-session.txt`

## Phases

### Phase 1 — App-starter cleanup ✅ done (commit `050275b`)
**Scope:** retire two open items from app-starter v3.

- Drop Playwright smoke suite from open items permanently. Update
  `/home/dustin/dev/joeybuilt/app-starter/next-session.txt` and (if mentioned)
  `/home/dustin/dev/joeybuilt/app-starter/checklist.md`.
- Generate Drizzle migration for the `audit_log` and `notification_log` tables.
  ⚠ One-way door (D1.a): pushing migration to prod modifies the live database. Operator
  sign-off gate before `pnpm db:push`.
- App-starter open-items list shrinks to one (better-auth stripe plugin, blocked upstream).

**Dependencies:** none.
**Context budget:** ≤15%.
**Subagents:** none (small; main context fine).
**Exit criteria:**
- App-starter `next-session.txt` no longer lists Playwright.
- Drizzle migration file generated and reviewed.
- ⚠ migration NOT pushed to prod yet — held for operator gate.

### Phase 2 — Plexo Core endpoint audit ✅ done — Path B confirmed
**Scope:** verify `/api/v1/...` routes exist for everything pushd needs, before any
pushd refactor work begins. Closes pre-mortem F3.

**Result:** ALL 10 deploy-AI helpers in pushd's `@pushd/plexo-client` call non-existent
endpoints. Operator chose Path B — refactor helpers to use generic `aiComplete` with
deploy prompts (no Core changes needed; also fixes silent failures).

- Inspect `apps/api/src/routes/` in the plexo monorepo. List endpoints.
- Cross-reference against pushd's `@pushd/plexo-client` helper list (analyzeRepo,
  diagnoseBuildError, suggestEnvVars, preDeployAnalysis, generateChangelog,
  deployment-monitor, etc).
- Each helper boils down to an `aiComplete` call w/ a domain-specific prompt OR a
  domain-specific Core endpoint. For ones that need a domain endpoint, verify it exists.
- For any gap, escalate to operator: build the Core endpoint OR rescope the helper to use
  generic `aiComplete`.

**Dependencies:** Phase 1 done (no real dep, but keeps order sane).
**Context budget:** ≤20%.
**Subagents:** Explore subagent for Core route inventory, ≤300-word return.
**Exit criteria:**
- Written list of every Core endpoint pushd helpers depend on.
- Each helper marked: "uses generic aiComplete" OR "uses Core endpoint X".
- Zero unresolved gaps. Any open items blocked on Core changes escalated for separate
  Plexo work item before Phase 5 starts.

### Phase 3 — Fonto swap ✅ done (commit `9432a32` in fonto)
**Scope:** clone fonto locally, swap `lib/plexo.ts` + `lib/plexo-registration.ts` to the
SDK, typecheck, push.

**SDK gaps closed:** publishEvent, storeMemory, searchMemory, visionOcr added in v0.3.0.
**Bug fix shipped:** fonto's memory writes were silently failing in prod — wrong path
(`/api/memory/...` instead of `/api/v1/memory/...`). SDK uses correct path.
**Consumers bumped:** app-starter + levio re-pinned to ^0.3.0, both typecheck clean.

- Clone fonto from origin to `/home/dustin/dev/joeybuilt/fonto`.
- `pnpm add @joeybuilt/plexo-sdk@<latest>`.
- Rewrite `lib/plexo.ts` as facade calling SDK methods. Preserve any fonto-specific
  helpers (e.g., `plexoClassifyAsset`) that wrap aiComplete with domain prompts.
- Rewrite `lib/plexo-registration.ts` to use `createPlexoClient` + `register()`.
- Typecheck. Fix call-sites if shapes drift.
- Bump SDK if a missing method is discovered. Republish, bump fonto.
- Commit + push.

**Dependencies:** Phase 2 (in case Core gaps surface).
**Context budget:** ≤30%.
**Subagents:** Explore for fonto file inventory (≤300 words). Edit work in main context.
**Exit criteria:**
- Fonto typecheck clean.
- Fonto pushed to origin.
- SDK still on a version that satisfies all current consumers (no skew).

### Phase 4 — Nexalog swap ✅ done (commit `7ef71c0` in nexalog)
**Scope:** identical pattern to fonto. Clone, swap, typecheck, push.

**SDK gap closed:** `getConversations` added in v0.4.0.
**Bug fix shipped:** `plexoMemorySearch` was POSTing to `/memory/search` but Core mounts
that route as GET — every search silently returned [] in prod. SDK uses GET.
**Known unfixed:** SCL endpoints (`/scl/mutate`, `/scl/expand`, `/scl/record/meta`) don't
exist in Plexo Core. Nexalog's SCL helpers preserved as raw-fetch wrappers w/ TODO. Same
silent-fail behavior as before; proper fix waits on Core SCL routes.
**Consumers bumped:** app-starter + levio + fonto re-pinned to ^0.4.0, all clean.

**Dependencies:** Phase 3 done (shake out SDK gaps first).
**Context budget:** ≤30%.
**Subagents:** Explore for nexalog file inventory.
**Exit criteria:**
- Nexalog typecheck clean.
- Nexalog pushed.
- SDK version unchanged or bumped + all consumers re-pinned.

### Phase 5 — Pushd refactor (Path B confirmed) ✅ done (commits `06ef212` swap + `af5f0a8` deletion)
**Scope:** delete `@pushd/plexo-client`, move helpers to `apps/web/src/lib/plexo-deploy/`,
have each helper build a deploy-shaped prompt and call `plexo.aiComplete()` from
`@joeybuilt/plexo-sdk`. ⚠ One-way door — deletes a private monorepo package.

**Phase 2 finding (2026-05-09):** Pushd's `@pushd/plexo-client` was calling 10 phantom
Core endpoints (`/api/analyze-repo`, `/api/diagnose-build`, etc) that never existed in
Plexo Core. The helpers degrade silently — pushd's deploy-AI features are effectively
non-functional today. Path B (use generic `aiComplete` with deploy prompts) is therefore
also a fix, not just a refactor. Path A (build 10 specialized Core endpoints) was rejected
as duplicative — those endpoints were always prompt engineering on generic AI.

- Clone pushd from origin to `/home/dustin/dev/joeybuilt/pushd`.
- Read `packages/plexo-client/src/index.ts` (372 LOC). Inventory every exported helper.
- Build the compat shim plan (per pre-mortem F1): keep `@pushd/plexo-client` re-exporting
  from the new location during migration; delete only after parity verified.
- Create `apps/web/src/lib/plexo-deploy/` directory. One file per helper.
- Each helper imports `plexo` from `apps/web/src/lib/plexo.ts` (which becomes a 5-line
  SDK init like Levio's).
- Update all `@pushd/plexo-client` import sites in pushd to import from
  `@/lib/plexo-deploy/<helper>` instead.
- Typecheck across all pushd workspaces.
- ⚠ Operator gate: parity verification in staging before deleting `@pushd/plexo-client`.
- Delete `packages/plexo-client/` (one-way door — gated). Remove from
  monorepo `pnpm-workspace.yaml`. Re-typecheck.
- Bump SDK if pushd surfaced gaps. Final SDK version locked here.
- Commit + push.

**Dependencies:** Phase 2 (Core endpoints), Phases 3 & 4 (SDK gaps shaken out).
**Context budget:** ≤45%.
**Subagents:** Explore for pushd helper inventory + import-site map. general-purpose for
the bulk swap once mapping is clear.
**Exit criteria:**
- All pushd code uses SDK + `lib/plexo-deploy/` helpers.
- `@pushd/plexo-client` deleted, monorepo workspace config clean.
- Pushd typecheck clean.
- Pushd pushed.

### Phase 6 — SDK 1.0.0 + handoff ✅ done (2026-05-09)
**Scope:** stabilize and ship 1.0.

**Result:** `@joeybuilt/plexo-sdk@1.0.0` published to npm. All 5 consumers (app-starter,
levio, fonto, nexalog, pushd) on ^1.0.0; typecheck clean across the board. Memory
recorded at `/home/dustin/.claude/projects/-home-dustin/memory/plexo-sdk.md`.

- Confirm SDK feature-complete: app-starter, levio, fonto, nexalog, pushd all on the
  same version + typecheck clean.
- Bump `packages/sdk/package.json` to 1.0.0.
- Update SDK's quick-start docs in `src/connect/index.ts` if shape drifted.
- Republish to npm with the existing publish flow.
- Bump every consumer to ^1.0.0 in one sweep.
- Update memories: SDK rollout complete; record consumers + final version.
- Final handoff to `/home/dustin/dev/joeybuilt/plexo/packages/sdk/next-session.txt`.

**Dependencies:** Phases 1–5 done.
**Context budget:** ≤15%.
**Subagents:** none.
**Exit criteria:**
- SDK at 1.0.0 on npm.
- Every consumer on 1.0.0.
- Memories updated.
- App-starter open-items list = 1 (stripe plugin only).

## Operator sign-off gates

- ⚠ **Gate 1 (Phase 1):** before `pnpm db:push` runs against prod for app-starter
  audit_log + notification_log migration.
- ⚠ **Gate 2 (Phase 5):** before deleting `@pushd/plexo-client` package — must verify
  staging parity first.
- ⚠ **Gate 3 (Phase 5 / Phase 6 boundary):** if Phase 5 surfaces Core endpoint gaps that
  require Plexo Core changes, halt and escalate.

## Out of scope

- fylo swap (deferred until app-starter migration).
- platform, service (no Plexo consumer surface).
- helm (Plexo extension provider, different SDK surface).
- App-starter Playwright suite (dropped per operator decision).
- better-auth stripe plugin (blocked upstream, defer).
