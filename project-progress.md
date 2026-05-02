# Project System Progress

Last updated: 2026-05-02
Current phase: 2 (Phase 2 deliverables complete — ready to ship-gate and move to Phase 3)
Last commit: ccf4403

## Phase Status
- [x] Phase 0 — Audit
- [x] Phase 1 — Schema
- [x] Phase 2 — Execution Engine (types, escalate, terminal-fail wiring, plan persistence, TASK_COMPLETED emission, reflect listener, per-step lifecycle writes)
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

Phase 2 closing items committed (this session):

- **`TASK_COMPLETED` emission** — `apps/api/src/agent-loop.ts` now publishes `TOPICS.TASK_COMPLETED` with a `TaskCompletedPayload` (description, outcome, qualityScore, durationMs, toolsUsed) right after the `completeTask(...)` + `recordTaskEvent('complete')` block. The previous inline `recordTaskMemory` block was **removed** — task-memory writes now have a single owner (the reflect listener). `memory/consolidation.ts:160` continues to subscribe to the same topic for anti-bloat.
- **`reflect.ts` listener** — new `packages/agent/src/tasks/reflect.ts` subscribes to both `TOPICS.TASK_COMPLETED` and `TOPICS.TASK_FAILED`, formats synthetic turn text, and routes through `recordTaskMemory` (success/partial outcomes carry `qualityScore` + `durationMs`; failures carry the 4-field escalation summary as notes). `aiSettings` are loaded on-demand via `loadSettingsFromInstances` so shorthand summarization still runs in the listener path. Wired at startup from `apps/api/src/index.ts` next to `initConsolidationListener`. Idempotent via an `_initialized` guard.
- **Per-step lifecycle writes** — `packages/agent/src/executor/index.ts` now does a two-phase write per outer iteration:
    1. Pre-step `INSERT` with `state='running'`, `started_at`, `attempts: 1`. Returns the row id; on failure, falls back to the historical end-of-step single-insert path.
    2. End-of-step `UPDATE` with `state='completed'`, `completed_at`, `attempts = stepRetries + 1`, `step_type` (`tool_call` or `llm_generation` derived from whether the step produced any tool calls), plus the legacy `model/tokens/toolCalls/outcome/stepState/isTerminal` payload.
    3. The inner `generateText` retry loop is wrapped in a try/catch that flips the running row to `state='failed'` with the captured `error` message before re-throwing — so a transient-retry exhaustion now produces a `failed` step row before the agent-loop's `markTaskFailed` pipeline takes over.
- New package export: `@plexo/agent/tasks/reflect`.
- New event-payload type: `TaskCompletedPayload` (added to `packages/agent/src/tasks/types.ts`).
- Workspace typecheck: 18/18 pass.
- Tests: agent 984/984 pass; api 778/788 pass — same 10 pre-existing failures (`chat-quality.test.ts`, `training-data.test.ts`) as the prior commit baseline.

Phase 2 ship-gate considerations before moving to Phase 3:

- `pnpm db:migrate` was **not** re-run in this WSL environment (no DATABASE_URL). Phase 1's migration `0104_project_system_phase1.sql` still needs to be applied against the target DB — no new migrations were added in this session.
- `pnpm build` was **not** run; only typecheck + tests. Run before the gate is officially closed.
- The reflect listener writes one task-memory row per `TASK_COMPLETED`/`TASK_FAILED` event; consolidation will trim long-tail entries via the existing 50-row threshold.

Notes / known limits:

- The two-phase step write only handles the model-call path's throw via try/catch. Other throws inside the iteration body (truncation `PlexoError` at the truncation-loop bail-out, mid-run `TASK_COST_CEILING` / `COST_CEILING_REACHED` PlexoErrors) leave the running row in `state='running'`. Acceptable for now — `cleanupStaleTasks` and a future Phase 3 sweeper can reap orphaned step rows. Wider try/catch would require re-indenting ~500 lines of iteration body; revisit only if step-row leaks become observable.
- Step `state='failed'` does **not** fire on detected `invalidToolCalls` (Zod validation failures). Those are a hint-and-retry pattern — the model produced bad arguments but the iteration itself ran successfully. State remains `completed` for those rows; the legacy `outcome` field captures the partial-success nuance.
- `recordTaskMemory` from the listener loads workspace AI settings via `loadSettingsFromInstances`, which reads the DB. If the listener fires for a workspace whose settings are missing, shorthand summarization is skipped silently and the row still lands.
- Pre-existing api test failures unchanged — do **not** treat as a regression.

Audit assumptions still in effect (override if needed):
- No Inngest. Postgres-queue stack only.
- `tasks.status` kept (no rename to `state`).
- Confirmation TTL still 5min default; per-call override path exists but unused.
