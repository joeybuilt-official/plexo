# Project System Progress

Last updated: 2026-05-02
Current phase: 2 (in progress — types, escalate, terminal-fail wiring + plan persistence committed; reflectOnTask + per-step lifecycle remain)
Last commit: 59512ee

## Phase Status
- [x] Phase 0 — Audit
- [x] Phase 1 — Schema
- [ ] Phase 2 — Execution Engine (wiring + plan persistence done; reflectOnTask + per-step lifecycle remain)
- [ ] Phase 3 — Stale Task Monitor
- [ ] Phase 4 — Channel Notifications
- [ ] Phase 5 — Task UI
- [ ] Phase 6 — Memory Integration
- [ ] Phase 7 — Wire Existing Tasks

## Handoff Notes

Phase 1 complete. User overrode the Phase-0 gate and authorised continuation; I proceeded with the audit's recommended defaults (commit `b216857`):

- **Pivot to postgres-queue (no Inngest):** assumed YES (the codebase has no Inngest, so this was the only option short of bringing it in).
- **Keep `tasks.status` name:** assumed YES (no rename — invasive, no benefit).
- **Confirmation TTL:** unchanged for now (5min). Will revisit in Phase 2/3 if needed.
- **Concrete failure mode:** still unknown. The Phase-1 additions (durable plan, per-task wall-clock, structured failure_reason, step lifecycle) are useful regardless of which specific symptom is driving the rebuild.

User should confirm or override these assumptions on next session.

`pnpm db:migrate` was **not** run (no DATABASE_URL configured in this WSL environment). Migration `0104_project_system_phase1.sql` is committed; user runs `pnpm db:migrate` from `packages/db` against the target database when ready.

Drizzle-kit `db:generate` was **not** used because the repo has unrelated pre-existing enum drift (`artifact_priority` vs. legacy `plugin_type`) that triggers an interactive prompt. Manual SQL is consistent with the repo's pattern from migration 0024 onward — meta snapshot files only exist through 0023.

Phase 0 audit artifacts (still authoritative for Phase 2+):
- `docs/plexo-project-audit.md` — synthesis + recommendations
- `docs/project-audit-schema.txt` (4706 lines)
- `docs/project-audit-protocol.txt` (82 lines)
- `docs/project-audit-inngest.txt` (0 lines — confirms no Inngest)
- `docs/project-audit-channels.txt` (1196 lines)

Phase 1 deliverable summary (commit `b216857`):
- `packages/db/src/schema.ts` — added enums `task_step_state`, `task_step_type`; new columns on `tasks` (`plan`, `wall_clock_limit_sec`, `failed_at`, `failure_reason`); new columns on `task_steps` (`state`, `step_type`, `step_spec`, `attempts`, `error`, `started_at`, `completed_at`); new index `task_steps_task_state_idx`.
- `packages/db/drizzle/0104_project_system_phase1.sql` — idempotent (`IF NOT EXISTS` / `DO` blocks), backfills existing terminal task_steps to `state='completed'`.
- Workspace typecheck: 18/18 packages pass.

Phase 2 subset committed (commit `38d75bb`):
- `packages/agent/src/tasks/types.ts` — Zod `EscalationSummarySchema`, `FailureReason` enum, `TaskFailedPayloadSchema`, `TaskStepState` / `TaskStepType` literal unions matching DB enums.
- `packages/agent/src/tasks/escalate.ts` — `generateEscalationSummary(input, aiSettings)` (LLM via `withFallback` + `summarization` task type) with `deterministicEscalation` fallback per FailureReason.
- New package exports: `@plexo/agent/tasks/types`, `@plexo/agent/tasks/escalate`.

Phase 2 wiring + plan persistence committed (commit `59512ee`):
- New `packages/agent/src/tasks/terminal-fail.ts` exporting `markTaskFailed({ taskId, workspaceId, failureReason, errorText, taskDescription, ..., aiSettings?, requireFromStatus? })`. One-stop call: generates escalation (LLM with deterministic fallback), writes `status='failed'`, `failed_at`, `failure_reason`, formatted `outcome_summary`, clears `claimed_at`/`claimed_until`, then emits `TOPICS.TASK_FAILED` with `TaskFailedPayload`. Returns `{ transitioned, summary }` so `requireFromStatus` callers can detect a guard miss.
- New package export: `@plexo/agent/tasks/terminal-fail`.
- Wired into 7 terminal-fail sites in `apps/api/src/agent-loop.ts`:
    1. `no_ai_credential` (line ~378)
    2. `cost_ceiling_exceeded` (line ~427)
    3. approval **rejected** (with `requireFromStatus: 'awaiting_approval'`)
    4. approval **timeout** (`ConfirmationExpired` + same guard)
    5. executor failure path → transient → `requeueForRetry` returns `'max_attempts'` (line ~1212)
    6. `cleanupStaleTasks` `requeueForRetry` `'max_attempts'` (line ~1352)
    7. `recoverGhostTasks` `requeueForRetry` `'max_attempts'` (line ~1407)
- Plan persistence: `db.update(tasks).set({ plan }).where(eq(tasks.id, task.id))` immediately after planner returns, wrapped in try/catch (non-fatal). Adjacent to existing `task_planned` SSE emission.
- Removed `failTask` from the `@plexo/queue` import — every old call site now goes through `markTaskFailed` instead.
- Workspace typecheck: 18/18 pass.
- Tests: agent 984/984 pass; api 778/788 pass — the 10 failures (`chat-quality.test.ts`, `training-data.test.ts`) are pre-existing on `bf36701` baseline, unrelated to this change.

Phase 2 remaining work for next session:
1. **`reflectOnTask` listener** — `packages/agent/src/tasks/reflect.ts` subscribed to `TOPICS.TASK_COMPLETED` and `TOPICS.TASK_FAILED`. The `TASK_FAILED` topic is now emitting (`TaskFailedPayload` with the 4-field summary). `TASK_COMPLETED` is **not yet emitting** anywhere in the codebase even though `memory/consolidation.ts:160` already subscribes to it — that's a pre-existing gap; emitting it from `agent-loop.ts:904` (after `completeTask`) is part of this work. Listener formats synthetic turn text and routes through the existing memory extraction pipeline (this is also Phase 6 work — safe to start now).
2. **Per-step lifecycle writes** — executor (`packages/agent/src/executor/index.ts`) needs to flip `task_steps.state` `pending → running → completed | failed` and populate `started_at`, `completed_at`, `attempts`, `error`. Today it only writes `outcome` + `isTerminal`. Phase 1 schema added the columns; now make them actually used.

(1) and (2) are independent; either can go first.

Notes for next session:
- `markTaskFailed` is idempotent on `status='failed'` updates, so calling it twice won't corrupt state — but `TASK_FAILED` will be re-emitted both times. If a future caller might race, it should pass `requireFromStatus` to suppress the duplicate event.
- `markTaskFailed` does **not** touch `task_steps`. When (2) lands, the executor's catch path should also mark the in-flight step `failed` before bubbling up to the agent-loop's transient-retry/markTaskFailed pipeline.
- Sweepers (`cleanupStaleTasks` / `recoverGhostTasks`) intentionally pass no `aiSettings` to `markTaskFailed` — they batch-process tasks across workspaces and we don't want to load AI settings for each. Result: sweeper failures use the deterministic escalation summary only. If an LLM-quality narrative for stuck-task escalation matters, refactor to pass workspace-scoped settings.
- `TASK_FAILED` topic was already declared in `event-bus.ts:33` (`'plexo.task.failed'`) — no edit needed there. Item (3) from the previous handoff is folded into the wiring above.

Audit assumptions still in effect (override if needed):
- No Inngest. Postgres-queue stack only.
- `tasks.status` kept (no rename to `state`).
- Confirmation TTL still 5min default; per-call override path exists but unused.
