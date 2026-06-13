# Plexo B1 tail + gated audit items — master plan

Mode: autonomous (auto-chain)
Project root: /workspace/plexo
Artifacts: /workspace/plexo/.b1-phased/ (plan.md, checklist.md, adr/, next-session.txt)
Branch: main. HEAD at plan creation: 76b2915.
ADR: /workspace/plexo/.b1-phased/adr/0001-b1-tail-and-gated-items.md

## Goal
Finish the B1 repository-boundary refactor (migrate the final 13 route files off
direct `db.` into per-aggregate repositories), deploy to prod in batches, flip
PLAN.md B1 → done; then surface (not execute) the gated A2/A3/A5/A6/B3 items.

## Conventions (locked — see ADR + the 52 already-migrated files)
- Per-aggregate repo `apps/api/src/repositories/<aggregate>.repository.ts`; SPDX
  header + doc comment referencing arch-findings B1 (copy `dashboard.repository.ts` style).
- Behavior-preserving: ONLY SQL moves. Routes keep auth/validation/encryption/
  shaping/side-effects. Preserve workspace scoping in moved queries.
- Extend shared repos (channels/workspaces/sprints/members), don't duplicate.
- Per file: grep db calls → create/extend repo → `import * as <name>Repo from
  '../repositories/<aggregate>.repository.js'` → remove unused db/eq/and/sql/table imports.
- Verify clean: `grep -nE "\bdb\.(select|insert|update|delete|execute)|from '@plexo/db'" <route>` shows no query calls (enum/type-only imports OK).
- Typecheck: `cd apps/api && ../../node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | grep -v vision.ts` (vision.ts:255 parse error pre-existing — ignore). pnpm NOT installed.
- Commit: stage explicit paths only (never `-A`); `git diff --stat` + hunk-check first (shared repo, another agent live). Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>.

## Deploy recipe (prod = plexo-api on the host; app.getplexo.com)
- `ssh <server>` directly (inside claude-code-rc). Announce NAS + hostname gate on writes.
- `git diff <base> <head> -- apps/api/src > /tmp/p.patch`; one `git apply` per fresh pipe:
  `cat /tmp/p.patch | ssh <server> '[ "$(hostname)" = "NAS" ] && cd /data/appdata/appdata/source/plexo && git apply --verbose 2>&1; echo RC=$?'`
  On reject: GNU `patch --fuzz=5` or single-hunk extraction.
- Build (bg): `ssh <server> '... && cd /data/appdata/appdata && docker compose build plexo-api'`
- Recreate: `docker compose up -d --no-deps --force-recreate plexo-api`
- Verify: health=healthy + fresh StartedAt, `wget -qO- 127.0.0.1:3001/health` → 200, a migrated route returns its auth gate (401/400) not 500.
- Prod DB = postgres (database plexo); migrations applied manually by psql (drizzle journal stale past 0129 — finding B6).

## Phases

## Phase 1 — Small tail (4 files)
- Scope: sprints, health, intelligence, pax. (Note: sprints/chat already have non-db edits from the naming feature — only their db queries remain.)
- Deps: none
- Subagents: cavecrew-investigator to inventory each file's exact db call sites + shared-repo reuse opportunities; main thread writes repos + rewires.
- Exit: 4 routes show no query calls; tsc clean; committed + pushed.
- Status: pending

## Phase 2 — Mid tail (3 files)
- Scope: intelligence-dashboard, stabilization, channels (extend channels.repository).
- Deps: none
- Exit: 3 routes clean; tsc clean; committed + pushed. Deploy Phases 1+2 to prod + verify.
- Status: pending

## Phase 3 — memory + tasks
- Scope: memory.ts (16+), tasks.ts (17+). Heavy; delegate inventory.
- Deps: none
- Exit: both clean; tsc; committed + pushed.
- Status: pending

## Phase 4 — auth + extensions
- Scope: auth.ts (18+), extensions.ts (18+). Watch for session/permission-graph side-effects staying in route.
- Deps: none
- Exit: both clean; tsc; committed + pushed. Deploy Phases 3+4 to prod + verify.
- Status: pending

## Phase 5 — Heavies: chat + connections
- Scope: chat.ts (2038L, 11+ db ops) and connections.ts (24+ ops). Most side-effect-dense; preserve SSE emits, job orchestration, executor aborts.
- Deps: none
- Exit: both clean; tsc; committed + pushed. Deploy to prod + verify.
- Status: pending

## Phase 6 — DISCOVERED multi-line-style files (16)
- Scope: the ranking grep `db\.(select|...)` only matches SINGLE-LINE calls; routes using multi-line `await db\n.select(...)` counted as ZERO and were never migrated. Accurate detector (excl tests): `grep -cE "\bawait db\b|\bdb\.(select|selectDistinct|insert|update|delete|execute|transaction)"`. 16 routes remain (all 1–4 calls): agents-run, app-grants, audit, escalation, webhooks, agents-active-stream, clarification, code, outcomes, revision-decision, users, webhooks-github, task-inject, task-stream, billing, profiles. (Everything migrated in Phases 1–5 + the 52 prior verified clean under the multi-line-aware grep.)
- Deps: none
- Subagents: 2 batches of 8 via general-purpose; same recipe.
- Exit: all 16 clean under the multi-line-aware grep; tsc clean; committed + pushed + deployed.
- Status: in-progress

## Phase 7 — Close-out
- Scope: final multi-line-aware sweep (zero non-test route files with direct db usage); flip PLAN.md B1 row → ✅ done with final count + note the counting-method fix; commit + push + final prod deploy/verify.
- Deps: Phases 1–6
- Exit: PLAN.md updated; prod healthy on final HEAD.
- Status: pending

## ⚠ Gated — surface, do NOT execute (operator sign-off required)
- A2 — activation: seed `workspace_app_grants` + `PROFILE_ENFORCEMENT_MODE=enforce`.
- A3 — retire shared `PLEXO_SERVICE_KEY` → per-app keys (fleet-wide).
- A5 — DRAFT_0124 migration.
- A6 — money real→numeric.
- B3 — SSE Redis fan-out.
These close real security/scaling risk and are higher-leverage than the B1 tail.
When B1 is done, present these as the next frontier; each is a one-way / fleet /
migration door — do not start without explicit "yes".

## Decisions / deviations log
- 2026-06-13: autonomous mode armed (audit-continuation memory + operator "continue if needed"). OSS benchmark skipped; expert panel compressed to one recorded tension (ADR). Phased artifacts under `.b1-phased/` to avoid collision with existing `PLAN.md` and another agent's `.e2e-phased`/`.followup-phased`.
