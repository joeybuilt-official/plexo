# Plexo UI — Phase 2 progress

Dedicated UI progress log (kept OUT of the shared, hot `progress.md`, which a
concurrent initiative also writes). Branch: `plexo-ui` (merge to main via ship
gate; do not commit UI work to main directly).

## Slice 1 — live SSE step feed on running task detail (shipped to main: c887e98)
- `apps/web/.../tasks/[id]/_use-task-step-stream.ts` — client hook over existing `GET /api/v1/tasks/:id/steps/stream`.
- `_live-steps.tsx` — maps streamed `task_steps` → `StepRow` (collapsible, Claude-style).
- Wired into the task page running/claimed branch.

## Slice 2 — workspace "agents in action" feed (branch plexo-ui)
**Backend (new, builds on existing data only — no schema change):**
- `apps/api/src/routes/agents-active-stream.ts` — `GET /api/v1/agents/active/stream?workspaceId=`. Continuous SSE (no terminal `done`), polls every 2s. Emits `{ type:'agents', ts, data: AgentSnapshotItem[] }`: per active task → `{ id, role(type), status, parentId, outcomeSummary, step:{stepNumber, stepType, state, summary}|null }`. Active = `['queued','claimed','running']`. Pure `buildAgentsSnapshot()` factored out for tests.
- Registered in `apps/api/src/index.ts` at `/agents` (after `requireAuth`).
- Test `__tests__/agents-active-stream.test.ts` — 6/6 (snapshot mapping, error>outcome, 160-char truncation, active-status set).

**UI:**
- `apps/web/.../agents/_components/use-active-agents-stream.ts` — client hook; replaces the agent list each snapshot tick; reconnect on error.
- `_components/active-agents-live.tsx` — multi-agent TREE: fan-out children + critic tasks nest under their parent via `parentId`; each node shows role + `StatusBadge` + current-step summary; expands to slice-1 `LiveSteps` for full detail. Empty state when nothing in flight.
- `agents/live/page.tsx` — client page (`useWorkspaceId`), route `/app/agents/live`.
- Copy uses plain "agents/steps" language; no "embedding"/"vector".

**Ship gate (slice 2):** `tsc -p apps/api` clean · `tsc -p apps/web` clean · `@plexo/web build` ✓ (route `/app/agents/live` built) · new test 6/6. **NOT deployed** (batch the apps/web + plexo-api redeploy).

### Notes / next
- Design skill `/mnt/skills/public/frontend-design/SKILL.md` absent in this env — built on existing `@plexo/ui` (custom CVA). Web alias is `@web/*` (not `@/*`).
- Next: revision review/approve UI (today Telegram-only) + outcomes/learning view (verdicts, disagreements, lessons), per HANDOFF.
- Slice-1 enhancement available: `task_steps` rows carry `model`/`tokensIn`/`tokensOut`; `LiveSteps` currently maps `model:null` — could surface them.

## Channel-agnostic interaction layer (branch plexo-ui) — per docs/channel-interaction-layer-design.md

**Phase A — skeleton (commit e6c63d8).** Unified decision intent `{targetType,targetId,choice,actor}` (locked dec 1); `ChannelRegistry`+`ChannelAdapter`; `applyDecision()` routes by `targetType` (revision→applyRevision/rejectRevision, task→recordHumanVerdict, approve→accept); generic seam `POST /api/v1/revisions/:id/decision`. 8 tests. Confirmed NO semantic blocker first (handler signatures/returns compatible).

**Phase B — Telegram→adapter + web + legacy (commit df5b6a8).** `telegram-adapter.parse()` turns "approve|reject <uuid>" into a decision intent; `telegram.ts` now routes through the SHARED `applyDecision` (de-dup — no more inline `applyRevision` import). `web-adapter`: send=emit to workspace SSE topic, parse=web POST. `legacy-adapter.makeLegacyAdapter()` wraps slack/discord/twilio/gmail (send delegates to `deliverToOriginChannel`, parse no-op) — 770-line dispatcher untouched. `register.ts` registers all 6 at startup. **All 5 outbound still send** (legacy delegate to same fn). 17 channel tests + 56 telegram/delivery regression green.

**Phase C — revision-review UI, FIRST consumer (this commit).** Backend `GET /api/v1/revisions/pending?workspaceId=` (join promptRevisions→cronJobs, resolve `sourceOutcomeIds`→outcomeRecords) + pure `buildRevisionView` (3 tests). UI `app/app/revisions/page.tsx` (`/app/revisions`): per pending revision shows rationale + proposed diff + source outcomes, Approve/Reject → **POST to the same `/revisions/:id/decision` seam Telegram uses**. Plain copy ("routine updates", no embedding/vector).

**Gate (each phase):** tsc (api+web) clean · `@plexo/api`+`@plexo/web` build green · tests green. **NOT deployed** (batch the apps/web + plexo-api redeploy). No migration needed (all builds on existing tables).

**Open (escalated in design doc, deferred):** native outbound migration of the 4 legacy channels; de-dup of the Slack verdict path (`slack.ts:420`); optional `/tasks/:id/decision` verdict endpoint variant.

## Outcomes / learning view (branch plexo-ui) — SECOND consumer of the seam

**Phase 0 confirms (resolved before build):**
1. *Unify safety.* What makes verdict (task) + approval (revision) safe under one `DecisionIntent`: the intent is only the **addressing envelope** (`{targetType, targetId, choice, actor}`), NOT the handling. `applyDecision` branches by `targetType` to the two handlers, which keep their own preconditions and return contracts — `recordHumanVerdict(taskId, 'accept'|'reject')` is an idempotent, non-fatal column UPDATE (no state machine, returns void); `applyRevision`/`rejectRevision(revisionId, reviewedBy)` are a guarded state machine (not-found / not-pending / stale-base-hash → `{ok:false,error}`). Semantic check that passed: (a) `taskId` vs `revisionId` are disjoint id spaces, routed by `targetType`, never cross-dispatched; (b) the `approve|reject` vocabulary is total for both sides (`approve→accept` is the only translation, locked dec 1); (c) `actor` is advisory metadata both accept. The verdict path discards `{ok}` (always logically ok), the revision path surfaces `{ok,error}`→409. So unifying the envelope does not collapse the distinct semantics — no blocker.
2. *web-adapter.parse was vestigial.* It was registered but never on a live inbound path — only `telegramAdapter.parse()` was invoked (telegram.ts:785); the web revision UI POSTed to `/revisions/:id/decision`, which built the `DecisionIntent` **inline**, bypassing the adapter. Resolved by **wiring web inbound through it** (not deleting): `revision-decision.ts` POST now assembles the raw body and runs it through `webAdapter.parse()` → `applyDecision` (web is a first-class channel, same seam as Telegram). No vestigial half. `adapters.test.ts` (9) + `decision.test.ts` (8) + `revision-decision.test.ts` (3) still green.

**Backend (new, existing tables only — no migration).** `GET /api/v1/outcomes?workspaceId=` (`apps/api/src/routes/outcomes.ts`, mounted at `/outcomes` after `requireAuth`). Joins `outcome_records` ← `cron_jobs` (routine name) + `tasks` (type/status), workspace-scoped via `or(cronJobs.workspaceId, tasks.workspaceId)` so both routine- and task-originated outcomes are covered; ordered `ts` desc, capped 200. Distilled lessons: `prompt_revisions` for the workspace mapped by `sourceOutcomeIds` → per-outcome `lessons[]`. Pure `buildOutcomesView(rows, lessonsByOutcomeId)`: verdict pair + `disagreement` (polarity map `complete/failed` vs `accept/reject`; flags only when both present and opposed; unknown/null → no flag) + linked lessons. Sparse-safe (DISTILL_ENABLED=false → `lessons` usually `[]`). Test `__tests__/outcomes.test.ts` — 9/9 (pairing, both disagreement directions, agree, missing-verdict, unknown-value, lesson attach, distill-off empty, empty input).

**UI `app/app/outcomes/page.tsx` (`/app/outcomes`).** Client page (`useWorkspaceId`). Per outcome: title (routine/task/trigger) + timestamp, summary, automated assessment badge **side-by-side** with human verdict badge, `Verdicts disagree` flag when they oppose, and "What Plexo learned" (lesson rationale/version/status) where present. Plain copy, quiet empty state ("No outcomes yet."). Standalone route, not nav-wired (matches `/app/revisions`, `/app/agents/live`).

**Gate:** tsc (api+web) clean · `@plexo/api` emit-build + `@plexo/web` `next build` exit 0 (`/app/outcomes` compiled) · full api suite 1277 passed / 3 skipped / 0 fail. **NOT deployed** (batch the apps/web + plexo-api redeploy). No migration.

## Integration proof + CI-flake fix (branch plexo-ui) — verification only, NO merge/deploy/migration

**Why.** Env-independent suite was green (2606) but integration had NEVER run green — all 64 fails were `connect ECONNREFUSED 127.0.0.1:5432/6379` (no Postgres/Redis). A real integration regression would have been invisible in that noise. Closed it by standing up isolated ephemeral services and getting a real run.

**Isolated stack (no live infra touched).** Host ports 5432/6379 are taken by live services (immich-redis, a prod pg) and this container's docker socket is a restricted proxy (run/build/network all 403). So: ran throwaway `pgvector/pgvector:pg16` + `valkey/valkey:8-alpine` on the host host docker, attached to `app-stack_claude-net`, reachable by name (`plexo-eitest-pg`/`plexo-eitest-redis`) — no host-port publish, no collision, tmpfs, throwaway creds. Torn down after.

**Schema bring-up surfaced 3 PRE-EXISTING migration-hygiene issues (not plexo-ui, NOT fixed here — flagged so CI can be fixed and nothing merges silently):**
1. The journaled `drizzle-kit migrate` / `migrate()` path **fails on a fresh DB**: it applies the pending batch in one transaction, so `0116`'s `ALTER TYPE auth_type ADD VALUE 'paired_session'` and `0117`'s INSERT using it collide (`55P04 unsafe use of new value`). Incremental prod deploys never hit it; a clean CI DB does. Worked around for the proof by applying each statement with autocommit.
2. Four SQL files are **on disk but absent from `_journal.json`** (`0122_outcome_records`, `0123_prompt_revisions`, `0125_lessons_graphiti_tracking`, `DRAFT_0124_fanout_fields`) → the journaled migrate **silently skips** them. `0122/0123` are the outcomes-feature tables; `DRAFT_0124` adds `tasks.fanout_depth`/`fanout_total` and is marked "DO NOT APPLY until operator approves" **yet running code references `tasks.fanout_depth`** (45 integration assertions needed it). Code/migration gap.

**Integration result (services UP).** ECONNREFUSED eliminated (0). **84 tests passed, 0 assertion failures, 44 skipped (128).** The prior 64 were confirmed **purely environmental** — the exact Phase C (operability), Phase D (confirm-gate), Phase F2 (task-detail-extended) tests that were "failing" now PASS. 9 files remain blocked at file/hook level by **3 further environmental bootstrap gaps, none in the plexo-ui surface, none assertion failures**: (a) 6 files — better-auth users-table not bootstrapped (`column "emailVerified" does not exist`; drizzle made `email_verified`, better-auth owns/syncs the camelCase column in real envs) → cascades to `workspaces_owner_id_users_id_fk`; (b) Graphiti tests — `GRAPHITI_SIDECAR_URL` unset (external sidecar); (c) `phase-h-signup`/`phase-l-5-tom` — vite can't resolve `packages/storage/tsconfig.json` `extends "../../tsconfig.json"` (tooling). Missing CI env to reach 100%: better-auth schema sync + a Graphiti sidecar + storage tsconfig fix.

**Flake fix (test-config only, the sole committed change).** Under parallel turbo load two pure-mock files timed out (pass isolated): `cron-parse-nl.test.ts` (heavy `await import('../cron.js')` in `beforeAll` > 10s) and `workspaces-contract-fuzz.test.ts` (first `ensureServer()` request > 15s). Raised just those timeouts — `beforeAll(..., 60_000)` and `vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })`. No logic touched. Verified under load: both now ✓ (4.8s / 18.6s), `@plexo/api` back to **1277 passed / 3 skipped** and turbo **9/9** (was 8/9 + 1 fail).

**Reconcile.** `test:all` with stack up: turbo 2550 passed (agent 1226 · api 1277/3-skip · sdk 32 · mcp 9 · graphiti-bridge 6) + unit 56 = **2606 env-independent, identical to prior — no regression**, now flake-stable. Integration newly executes for real: **+84 passing tests** (previously 0 could run). The only remaining red is the 3 environmental bootstrap gaps above. **Nothing real surfaced. NO merge / NO deploy / NO migration.**

**Gate:** tsc (api+web) clean · `@plexo/api` emit + `@plexo/web` `next build` exit 0 · turbo 9/9 · unit 56 · integration 84 pass / 0 assertion-fail. Commit = flake fix only (2 test files). Branch pushed, not deployed.
