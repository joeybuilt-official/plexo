# Project System Progress

Last updated: 2026-05-02
Current phase: 2 (in progress — types + escalation summary committed; wiring + plan persistence + reflectOnTask remain)
Last commit: 38d75bb

## Phase Status
- [x] Phase 0 — Audit
- [x] Phase 1 — Schema
- [ ] Phase 2 — Execution Engine (partial: types.ts + escalate.ts done; wiring pending)
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

Phase 2 remaining work for next session:
1. Wire `generateEscalationSummary` into terminal-fail call sites in `apps/api/src/agent-loop.ts` (`cleanupStaleTasks`, `recoverGhostTasks`, `requeueForRetry` max-attempts path, executor failure path) and write `tasks.failed_at` + `tasks.failure_reason`.
2. Persist planner output to `tasks.plan` after `planTask` returns (in `agent-loop.ts` post-plan).
3. Add `task.failed` topic to `packages/agent/src/plugins/event-bus.ts` (`TASK_FAILED: 'plexo.task.failed'`) and emit `TaskFailedPayload` from each terminal-fail site.
4. Implement `packages/agent/src/tasks/reflect.ts` listener on `TASK_COMPLETED` and `TASK_FAILED` — formats synthetic turn text and routes through the existing memory extraction pipeline (Phase 6 deliverable; safe to start once event is emitting).
5. Per-step lifecycle writes: have the executor flip `task_steps.state` `pending → running → completed | failed` and populate `started_at/completed_at/attempts/error`.

None of (1)–(5) are blocking each other; they can be done in any order. (1) and (2) are the highest leverage — they make the Phase 1 schema columns actually used.

Audit assumptions still in effect (override if needed):
- No Inngest. Postgres-queue stack only.
- `tasks.status` kept (no rename to `state`).
- Confirmation TTL still 5min default; per-call override path exists but unused.
