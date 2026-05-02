# Plexo Project System — Lifecycle Audit (Phase 0)

> Audit only. No code changes. This document determines what to build vs. fix in subsequent phases.

## TL;DR — Plan vs. Reality

**The plan's central architectural premise is wrong for this codebase.** Volkov's section assumes "Inngest already provides the durable execution substrate." Plexo has **zero Inngest references**. The actual durable substrate is:

- `@plexo/queue` — postgres-backed task queue using `SELECT FOR UPDATE SKIP LOCKED`
- `apps/api/src/agent-loop.ts` — polling worker (`POLL_INTERVAL_MS`) that claims and executes tasks

Most of what the plan proposes building **already exists**. The audit below maps each area against the spec so subsequent phases can be re-scoped against current reality.

---

## 1. Schema (tasks / task_steps / events)

`packages/db/src/schema.ts`

| Plan column | Actual column / table | Status |
|---|---|---|
| `tasks.state` | `tasks.status` (enum: `queued, claimed, running, complete, failed, blocked, cancelled, awaiting_approval`) | EXISTS — different name + value set |
| `tasks.plan jsonb` | not present (plans are ephemeral inside `executeTask`) | MISSING |
| `tasks.current_step_index` | not present | MISSING |
| `tasks.step_attempts` | `tasks.attemptCount` (task-level, not step-level) | EXISTS — different scope |
| `tasks.inngest_run_id` | n/a (no Inngest) | NOT APPLICABLE |
| `tasks.started_at` | `tasks.claimedAt` | EXISTS — analogous |
| `tasks.completed_at` | `tasks.completedAt` | EXISTS |
| `tasks.failed_at` | not present (`completedAt` covers terminal in some paths) | MISSING |
| `tasks.failure_reason` | `tasks.outcomeSummary` (overloaded) | PARTIAL |
| `tasks.result jsonb` | `tasks.deliverable jsonb`, `tasks.outcomeSummary` | EXISTS — different name |
| `tasks.quality_score` | `tasks.qualityScore` | EXISTS |
| `tasks.wall_clock_limit` | not present (hardcoded: 7d for queued, 2h for blocked, `claimed_until` for active) | MISSING |
| `task_steps.step_index` | `task_steps.stepNumber` | EXISTS |
| `task_steps.step_type` | not present | MISSING |
| `task_steps.step_spec` | not present (spec is in `tasks.context` + planner output) | MISSING |
| `task_steps.state` | `task_steps.outcome` (text, not enum) + `isTerminal bool` | PARTIAL |
| `task_steps.attempts` | not present at step level | MISSING |
| `task_steps.result` | `task_steps.toolCalls` + `task_steps.outcome` | PARTIAL |
| `task_steps.error` | folded into `outcome` | PARTIAL |
| `task_steps.started_at`/`completed_at` | only `createdAt` | MISSING |
| `task_events` (plan) | `plexo_ops_task_events` (workspaceId, taskId, eventType, fromState, toState, metadata, recordedAt) | EXISTS — different name |

**Adjacent existing tables that interact with the project system:**
- `sprints` — Plexo's "project" concept (workspaceId, repo, status, totalTasks, completedTasks, failedTasks, costCeilingUsd)
- `sprint_tasks` — links sprints to executable tasks
- `escalation_requests` — pending tool-level approvals (workspaceId, sessionId, toolName, payload, status, expiresAt)
- `conversations` — chat log; `conversations.taskId` FKs back to tasks

**Indexes that exist:**
- `tasks_workspace_status_idx`, `tasks_workspace_project_idx`, `tasks_project_id_idx`, `tasks_parent_id_idx`, `tasks_status_retry_idx`
- `task_steps_task_idx`
- `plexo_ops_task_events_workspace_task_idx`

---

## 2. Execution Protocol Wiring

The plan defines `PLAN | CONFIRM | EXECUTE | VERIFY | COMPLETE | ESCALATE`.

| Step | Code path | Status |
|---|---|---|
| PLAN | `packages/agent/src/planner/index.ts` (`planTask` — LLM produces `ExecutionPlan` with phases/steps/one-way-door flags) | EXISTS-AND-USED |
| CONFIRM | `packages/agent/src/executor/index.ts:820` "One-Way Door gate (§8.4)" + `apps/api/src/agent-loop.ts:845` "CONFIRM gate auto-approved via standing approval" | EXISTS-AND-USED |
| EXECUTE | `packages/agent/src/executor/index.ts` (`executeTask`) + `tool-runner.ts`, `tool-worker.ts`, `step-builder.ts` | EXISTS-AND-USED |
| VERIFY | `executor/quality-judge.ts`, `executor/structural-proof.ts`, `executor/side-effect-check.ts`, `executor/output-ceiling.ts` | EXISTS-AND-USED — multiple deterministic + LLM-judgment paths |
| COMPLETE | `tasks/agent-loop.ts:904` (`completeTask` from `@plexo/queue`) — writes `completed_at`, `qualityScore`, `outcomeSummary`, costs, tokens. Also `task_complete` tool call required by every task per `prompts/build-system-prompt.ts`. | EXISTS-AND-USED |
| ESCALATE | `packages/agent/src/escalation/manager.ts` + `apps/api/src/routes/escalation.ts` (approve/reject/SSE). | EXISTS-AND-USED — but tool-level approval semantics, not task-level failure narrative |

**Gap: 4-field escalation summary (what/why/action/recoverable) does NOT exist** — current escalation is a tool-call approval prompt, not a structured user-facing failure explanation. This is the one piece of the ESCALATE spec that needs new code.

`apps/api/src/analytics/sanitize.ts:21` defines `PipelineStep = 'PLAN' | 'CONFIRM' | 'EXECUTE' | 'VERIFY' | 'REPORT'` — REPORT is the analytics-facing terminal step.

---

## 3. Inngest Jobs

**Zero Inngest references in source tree** (verified via `grep -ri "inngest"` outside `node_modules`). Plan section specifying `step.run / step.sleep / step.waitForEvent` is not implementable as written.

**Actual async substrate:**
- Postgres queue: `@plexo/queue` (`push`, `claim`, `claimBatch`, `complete`, `fail`, `block`, `cancel`, `requeueForRetry`)
- Polling worker: `agent-loop.ts` `startAgentLoop()` — `setInterval(poll, POLL_INTERVAL_MS)`
- Periodic sweepers in same process:
  - `cleanupStaleTasks()` every 30 min — claim-expired → requeue or fail; blocked > 2h or queued > 7d → cancelled
  - `recoverGhostTasks()` every 5 min — running with stale claim → requeue
- HTTP cron: `apps/api/src/routes/cron.ts` (external trigger)
- CLI cron: `apps/cli/src/commands/cron.ts`

---

## 4. Channel Notifications

`apps/api/src/channel-delivery.ts` — comment line 159: *"Called from agent-loop.ts on every task completion/failure."* Provides post-completion delivery to the originating channel via `tasks.context.channelRef`.

Channel adapters present:
- `apps/api/src/routes/telegram.ts` (1213: handles `event.type === 'task_complete'`)
- `apps/api/src/routes/slack.ts`
- `apps/api/src/routes/discord.ts`
- `apps/api/src/routes/channels.ts` (CRUD)
- `apps/api/src/routes/message-deliveries.ts`

`apps/api/src/sse-emitter.ts` — `emitToWorkspace` for in-app real-time updates (e.g. `task_rejected`, approval events).

**Gap vs. plan:** the plan calls for *one notification per state transition* (planning, awaiting_confirmation, executing, verifying, completed, failed, cancelled). Today there is delivery on completion/failure and on approval timeout, but not on every transition — and no formatter that maps state → user-facing message per channel. Phase 4 of the plan would slot into `channel-delivery.ts` rather than create a new file.

---

## 5. Terminal State Handling

Code paths that write a terminal state:

- `@plexo/queue` `complete()` — `status='complete', completedAt=now()`
- `@plexo/queue` `fail()` — `status='failed', outcomeSummary=reason`
- `@plexo/queue` `cancel()` — `status='cancelled'`
- `@plexo/queue` `block()` — `status='blocked'` (semi-terminal; cleaned up after 2h)
- `@plexo/queue` `requeueForRetry()` — `status='failed'` once `attemptCount > maxAttempts`
- `cleanupStaleTasks()` — bulk `cancelled` for queued > 7d / blocked > 2h
- `agent-loop.ts:821` — `failed` when `awaiting_approval` times out

**Every terminal write also writes a `plexo_ops_task_events` row** via `recordTaskEvent` (state_transition audit). Tasks **do not silently disappear in current code** — every observed terminal state is reflected in DB. The plan's diagnosis ("tasks enter EXECUTE and never reach COMPLETE or ESCALATE") needs to be re-examined against this codebase before Phase 1: it may be a problem from an earlier iteration, or it may still occur in a specific path not covered by the sweepers (e.g. unhandled exception inside `executeTask` that escapes the catch).

---

## 6. Memory Integration

`packages/agent/src/memory/consolidation.ts:160` already subscribes to `TOPICS.TASK_COMPLETED` (event bus from `@plexo/agent/event-bus`). Comment: *"Memory consolidation listener registered on TASK_COMPLETED events"*.

`packages/agent/src/memory/conversation-bridge.ts` — extracts memory from conversation turns (`hasInstructionIntent`, `persistInstruction`, `extractConversationMemory`). Imported by telegram/discord/chat-app-transport routes.

`packages/sdk/src/types/events.ts:32` — `TASK_COMPLETED: 'task.completed'`, plus `AGENT_PLAN_CREATED`, `AGENT_STEP_COMPLETED`, `A2A_DELEGATION_COMPLETED`.

**Gap:** the listener consolidates older memories into summaries (anti-bloat). It does not extract atomic facts (`factType = 'decision' | 'convention'`) from completed/failed tasks the way the plan's `reflectOnTask` describes. Phase 6 would extend the existing listener rather than replace it.

---

## 7. UI Surface

**Already exists:**
- `apps/api/src/routes/tasks.ts` — `GET/POST /api/tasks`, `GET /api/tasks/:id`, `getResumeStep`
- `apps/web/src/app/app/tasks/page.tsx` — `/tasks` list view
- `apps/web/src/app/app/tasks/[id]/page.tsx` — task detail
- `apps/web/src/app/(dashboard)/tasks/[id]/page.tsx` — second detail view (dashboard layout)
- `apps/web/src/app/app/projects/[id]/page.tsx` — sprint/project detail
- Escalation inbox API (Phase 8): `escalation.ts` with SSE stream

**Gap vs. plan:** detail drawer that surfaces a 4-field escalation summary on failure does not exist (because that 4-field schema does not exist yet — see Section 2). Confirm/cancel actions in the UI are routed through `escalation_requests` approve/reject, not a `tasks/:id/confirm` endpoint.

---

## 8. Confirmation TTL

`packages/agent/src/escalation/manager.ts:71` — `DEFAULT_TTL_MS = 5 * 60 * 1000` (5 minutes).

Plan's diagnosis ("10-minute TTL") is close but not exact — actual default is **5 minutes**, even shorter. Reyes' point that the TTL is too short for "user in a meeting" still applies. TTL is configurable per-call (`input.ttlMs`) but call sites don't override it. No code path lets a user *resume* an expired confirmation.

---

## 9. Code-Path Tags

| Area | Tag |
|---|---|
| `tasks` table read/write | EXISTS-AND-USED |
| `task_steps` table | EXISTS-AND-USED (executor writes; UI reads) |
| `plexo_ops_task_events` | EXISTS-AND-USED (recordTaskEvent throughout agent-loop) |
| `escalation_requests` | EXISTS-AND-USED |
| `sprints` / `sprint_tasks` | EXISTS-AND-USED |
| Planner LLM call | EXISTS-AND-USED (`planTask`) |
| Sprint planner | EXISTS-AND-USED (`packages/agent/src/sprint/planner.ts`, 3min timeout) |
| Executor with tools | EXISTS-AND-USED |
| One-way-door gate | EXISTS-AND-USED |
| Stale task sweeper | EXISTS-AND-USED (30min) |
| Ghost task recovery | EXISTS-AND-USED (5min) |
| Channel delivery on completion | EXISTS-AND-USED |
| Memory consolidation on TASK_COMPLETED | EXISTS-AND-USED |
| `/api/tasks` REST | EXISTS-AND-USED |
| `/app/tasks` UI | EXISTS-AND-USED |
| Inngest workflow | MISSING (and not the right substrate for this codebase) |
| `tasks.plan jsonb` durable plan | MISSING |
| 4-field escalation summary | MISSING |
| Per-state notification formatter | MISSING |
| Atomic-fact `reflectOnTask` extraction | MISSING |
| Configurable per-task `wall_clock_limit` | MISSING |
| Resume-after-expiry for confirmations | MISSING |

---

## 10. Recommendations Before Phase 1

The plan was written assuming a greenfield build on Inngest. Reality is a mature postgres-queue system. Recommended adjustments:

1. **Phase 1 (Schema)** — pivot from "create tasks/task_steps/task_events" to *additive* changes:
   - Add `tasks.plan jsonb` (persist planner output for resumability)
   - Add `tasks.failed_at`, `tasks.failure_reason` (split from overloaded `outcomeSummary`)
   - Add `tasks.wall_clock_limit interval` (per-task configurable)
   - Add `task_steps.state` enum, `step_spec`, `attempts`, `started_at`, `completed_at`, `error`
   - **Do not** create a new `task_events` table — extend `plexo_ops_task_events` if needed.
   - **Do not** rename `tasks.status` → `tasks.state` — invasive, no real benefit.

2. **Phase 2 (Execution Engine)** — drop "Inngest workflow" framing. Instead:
   - Tighten `executeTask` to persist `tasks.plan` and per-step state on each transition so a crash mid-execute can resume.
   - Implement the 4-field escalation summary (`what/why/action/recoverable`) as a Zod schema + LLM call invoked on failure.
   - Surface `reflectOnTask` as a separate handler on `TOPICS.TASK_COMPLETED` / new `TOPICS.TASK_FAILED`.

3. **Phase 3 (Stale monitor)** — already built. Action: add per-task `wall_clock_limit` override and align cadence with the plan (currently 5min/30min, plan says 15min). Optional, low value.

4. **Phase 4 (Notifications)** — extend `channel-delivery.ts` with a state→message formatter; emit on planning / awaiting_confirmation / completed / failed only (skip per-step noise). Wire from `recordTaskEvent`.

5. **Phase 5 (UI)** — already built. Action: add detail-drawer fields for the new 4-field escalation summary.

6. **Phase 6 (Memory)** — extend the existing consolidation listener (or add a sibling listener) to extract atomic facts from `tasks.plan` + `task_steps` + result/failure; keep the conversation-bridge extraction for chat turns.

7. **Phase 7 (Wiring)** — the plan's "wire all task creation paths to Inngest" doesn't apply. Replacement check: every task creation path goes through `@plexo/queue.push()`. Verify this, audit any bypasses, ensure all paths set `context.channelRef` when appropriate.

---

## Audit Files

- `docs/project-audit-schema.txt` — 4706 matches (broad: `task|project|work_ledger|task_steps|task_events`)
- `docs/project-audit-protocol.txt` — 82 matches (`PLAN|CONFIRM|EXECUTE|VERIFY|COMPLETE|ESCALATE|protocol`)
- `docs/project-audit-inngest.txt` — **0 matches** (createFunction/inngest.send/step.run/step.sleep)
- `docs/project-audit-channels.txt` — 1196 matches (notify/sendMessage/channel/telegram/plexobot)

---

## Open Questions for User Before Phase 1

1. **Plan diagnosis vs. reality.** The plan says "tasks enter EXECUTE and never reach COMPLETE or ESCALATE." Current code has multiple sweepers and explicit terminal-state writes for every observed exit. Is there a specific symptom (a recent incident, a Sentry trace, a user-reported task that "vanished") driving this? Before adjusting Phase 1, we should pin down the actual failure mode — otherwise we risk building for a problem that's already solved.
2. **Inngest substrate.** The plan was written against a different stack. Confirm we're proceeding with the postgres-queue-based pivot (Section 10) rather than introducing Inngest.
3. **`status` vs. `state` rename.** Plan uses `state`. Existing schema is `status`. Rename = large blast radius. Recommend keeping `status`. Confirm.
4. **Confirmation TTL.** Plan says default 24h. Do you want that as default, or preserve 5min and add a per-call/per-workspace override?
