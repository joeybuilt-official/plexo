# ADR 0001 — B1 repository-boundary tail + gated audit items

## Status
Accepted — 2026-06-13. Autonomous (auto-chain) continuation.

## Context
The six-expert architecture audit (`arch-findings.md`, `PLAN.md §0`) produced a
"Sound with Fixes" verdict. The B1 finding — migrate route files off direct
`{ db }` imports into per-aggregate repositories under
`apps/api/src/repositories/<aggregate>.repository.ts` — is 52/82 route files
done across two prior sessions (HEAD `76b2915`). 13 route files with direct
`db.` query calls remain: `sprints`, `health`, `intelligence`, `pax`, `chat`,
`intelligence-dashboard`, `stabilization`, `channels`, `memory`, `tasks`,
`auth`, `extensions`, `connections`.

This ADR covers finishing that tail and teeing up (NOT executing) the
higher-leverage gated items A2/A3/A5/A6/B3.

## Decision
1. **Continue B1 with the exact established recipe.** Move ONLY SQL into the
   repo; routes keep auth, validation, encryption, request-shaping, numeric/JSON
   post-processing, and cross-cutting side-effects (audit, permission-graph
   mirrors, SSE emits, job orchestration, executor aborts, analytics). Preserve
   object-level authz (workspace scoping) inside moved queries. No interface
   ceremony (single impl). Type-only `import { someTable }` for a
   `typeof table.$inferSelect` annotation may remain.
2. **Extend shared repos, never duplicate.** `channels.repository.ts`,
   `workspaces.repository.ts`, `sprints.repository.ts`, `members.repository.ts`
   already exist; the `channels` route extends `channels.repository`.
3. **Skip OSS benchmark + heavy expert panel** (Step 2/3 deviation). The pattern
   is proven across 52 files; redesign would be churn. The one live tension
   (below) is recorded instead.
4. **Gated A-items are surfaced, never executed** without explicit operator
   sign-off: A2 (seed `workspace_app_grants` + `PROFILE_ENFORCEMENT_MODE=enforce`),
   A3 (retire shared `PLEXO_SERVICE_KEY` → per-app keys, fleet-wide), A5
   (DRAFT_0124 migration), A6 (money real→numeric), B3 (SSE Redis fan-out).
   These close real security/scaling risk and are higher-leverage than the B1
   tail, but each is a one-way / fleet-wide / migration door.

## Live tension (would-be expert-panel conflict)
- **Maintainability vs. Pragmatism.** A purist would split table-shared queries
  (e.g. `conversations` touched by chat, telegram, gmessages) into one
  conversations repo. Precedent already chose route-aggregate ownership with
  shared-repo extension only for the hot shared tables (channels, workspaces).
  **Resolution (safer default, autonomous):** keep route-aggregate ownership;
  extend a shared repo only when the SAME narrow query already lives there.
  Avoids cross-route coupling and big-bang reshuffles.

## Pre-mortem — 3 likely failure causes + fallbacks
1. **A moved query silently drops workspace scoping or changes result shape**,
   breaking authz or response. → Fallback: behavior-preserving line-for-line SQL
   move; `tsc --noEmit` per batch; per-batch prod gate-check (migrated route
   returns its normal 401/400, not 500) before moving on.
2. **Patch fails to apply on the prod overlay source tree** (prod-snapshot branch
   is dirty with unrelated overlay edits; e.g. `channel-ai.ts` diverged at L753).
   → Fallback: per-file `git apply`; on rejection, GNU `patch --fuzz` or extract
   the single clean hunk (proven recipe from the naming deploy).
3. **`git add <file>` bundles another agent's uncommitted edits** (happened once
   with `channel-ai.ts` stepCount edits). → Fallback: before each commit,
   `git diff --stat` + inspect hunks of every staged file; stage explicit paths
   only; never `git add -A`. Another agent is live in this repo (`.e2e-phased`,
   `.followup-phased`).

## Consequences
- 13 PRs-worth of mechanical change, batched + deployed to prod in groups.
- On completion, `PLAN.md` B1 row flips to ✅ and the gated A-items become the
  next, higher-leverage frontier (operator-driven).
