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
