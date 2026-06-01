# Plexo Proactive-Agent Harness Audit

**Date:** 2026-06-01  
**Scope:** `/workspace/plexo` (public) + `/workspace/plexo-internal` (internal build)  
**Method:** Read-only. Every claim cites a real path + line number.

---

## 1. Capability Matrix

| Capability | Status | Gap Type | Key File Refs |
|---|---|---|---|
| Routine def schema | PARTIAL | LOGIC | `packages/db/src/schema.ts:633` |
| Schedule trigger | **EXISTS** | NONE | `apps/api/src/routes/cron.ts`, `apps/api/src/cron-dispatch.ts` |
| Event trigger (webhook) | PARTIAL | LOGIC | `apps/api/src/routes/webhooks.ts:22` |
| Executor (scoped repos + connectors) | PARTIAL | LOGIC | `packages/agent/src/executor/index.ts:249` |
| Session persistence + observability | PARTIAL | UI | `packages/db/src/schema.ts:423` |
| Notify (Telegram) | **EXISTS** | NONE | `apps/api/src/channel-dispatch.ts:98` |
| Multi-agent coord | PARTIAL | LOGIC | `packages/db/src/schema.ts:316`, `packages/agent/src/sprint/runner.ts` |
| Learning loop | **EXISTS** | NONE | `packages/db/src/schema.ts:762`, `packages/agent/src/memory/` |
| Human surface (define/launch/watch/steer) | PARTIAL | UI | `apps/api/src/routes/cron.ts`, `apps/api/src/routes/approvals.ts` |

---

## 2. Capability Detail

### 2.1 Routine Definition Schema — PARTIAL / gap: LOGIC

`cronJobs` table (`packages/db/src/schema.ts:633`):

```
id, workspaceId, name, schedule (cron text), enabled,
taskType, taskContext (jsonb, arbitrary payload),
nextRunAt, lastRunAt, lastRunStatus, consecutiveFailures
```

**What's there:** schedule string, arbitrary JSONB context, enable/disable, run-status tracking.

**What's missing in schema:** no `prompt` text column (taskContext can carry one as a key, but it's untyped), no `repoUrl`/`branchRef`, no `connectorIds` (MCP packages to attach), no `notifyChannel`. Three or four typed columns away from a complete routine spec.

---

### 2.2 Schedule Trigger — EXISTS / gap: NONE

Full stack present:

- **Cron engine:** `apps/api/src/cron-dispatch.ts` — `dispatchDueJobs()` fires every ~60 s, queries `cron_jobs WHERE enabled = true AND next_run_at <= now()` with `FOR UPDATE SKIP LOCKED` for concurrent-safe dispatch.
- **REST CRUD:** `GET / POST / PATCH / DELETE /api/cron` + `POST /api/cron/:id/trigger` (manual fire) — `apps/api/src/routes/cron.ts:1–10`.
- **NL parser:** `POST /api/cron/parse-nl` — pure-JS parser (no LLM call) converts phrases like "every weekday at 9am" → cron expression (`cron.ts:153`).
- **One-shot:** schema supports `schedule = null` (one-time runs via `nextRunAt` only).

---

### 2.3 Event Trigger — PARTIAL / gap: LOGIC

**What's there:** Generic HMAC-signed webhook at `POST /api/v1/webhooks/:workspaceId` (`apps/api/src/routes/webhooks.ts:22`). Queue `source` enum already includes `github` (`packages/queue/src/index.ts:11-25`), so task metadata can declare GitHub origin.

**What's missing:** No GitHub-specific route — no `X-GitHub-Event` header parsing, no push/PR/issue fan-out, no GitHub App secret verification. A generic POST reaches the queue but the executor sees no event type context. Custom-POST webhooks work end-to-end; GitHub integration is one route away.

---

### 2.4 Executor — PARTIAL / gap: LOGIC

**What's there:**

- Full agentic loop: `packages/agent/src/executor/index.ts` (2 562 lines) — Vercel AI SDK `generateText()`, tool isolation via `node:worker_threads` with 90 s timeout (`executor/tool-worker.ts`).
- Scoped repos: `ctx.sprintWorkDir` (pre-cloned path, path-containment enforced for read/write/cwd — `executor/index.ts:249–318`). Sprint tasks carry `workerContainerId` (`packages/db/src/schema.ts:505`).
- MCP connectors: `packages/agent/src/connections/bridge.ts` (976 lines) generates tool lists from installed OAuth connections (GitHub, Gmail, Slack, Discord, Jira, Linear, Notion, Airtable…) per workspace at task start.
- Multi-model: `packages/agent/src/providers/call-model.ts` routes across Claude, DeepSeek, Groq, Mistral, xAI — model is runtime-configurable per workspace, no hardwired provider.
- Resume: `executor/index.ts:1565` — `resumeFromTaskId` → `buildResumeMessages()` reconstructs message thread from saved `task_steps.stepState` checkpoints.

**What's missing (for routine harness):**

- Connectors are workspace-scoped, not routine-scoped — no way to say "this routine gets GitHub + Gmail but not Slack."
- `sprintWorkDir` / repo cloning lives in the sprint flow, not in the cron→task dispatch path. A cron-triggered task today gets no auto-cloned repo.
- No Claude Code subprocess — this is Plexo's own executor. CC-native tools (CLAUDE.md, CC tool permissions, CC session IDs) are absent.

---

### 2.5 Session Persistence + Observability — PARTIAL / gap: UI

**What's there (data layer — complete):**

`task_steps` table (`packages/db/src/schema.ts:423`):

```
id, taskId, stepNumber, model, tokensIn, tokensOut,
toolCalls (jsonb), outcome (text), stepState (jsonb — resume checkpoint),
isTerminal, state (enum), stepSpec (jsonb), attempts, error,
startedAt, completedAt
```

Every step is written atomically. `stepState` is the serialized message context needed to resume from that step — crash recovery is architecture-native.

Escalation gates mid-run: `packages/agent/src/escalation/manager.ts` pauses on flagged tool calls with 5-min TTL; resolved via `POST /api/approvals/:id/approve` (`apps/api/src/routes/approvals.ts:59`). A `/approve-and-remember` endpoint (`approvals.ts:89`) stores standing approvals so the same tool never blocks again.

**What's missing:**

- No live-tail SSE endpoint for `task_steps` confirmed in API routes.
- Hub (`apps/hub/src/app/`) contains browse/ext/skills/publisher pages — no routine or session viewer page found.
- No "steer" (mid-run message injection) endpoint confirmed; approval gates are the only mid-run human touch.

---

### 2.6 Notify — EXISTS / gap: NONE

- `TELEGRAM_BOT_TOKEN` read at `apps/api/src/channel-dispatch.ts:98`.
- `POST /api/v1/channel/dispatch` delivers to Telegram, email (stub), push, SMS.
- Existing NAS Telegram bot (`apps/api/src/routes/telegram.ts:1607`) already handles incoming messages — outbound notify reuses the same bot token. Zero integration work needed for Telegram delivery from routine completion.

---

### 2.7 Multi-Agent Coordination — PARTIAL / gap: LOGIC

**What's there:**

- `tasks.parentId` self-reference (`packages/db/src/schema.ts:316`) — sub-task tree, FK on delete set null.
- Sprint runner (`packages/agent/src/sprint/runner.ts`) parallelizes tasks in topological waves (DAG ordering via `sprint/planner.ts`); monitors `task.status` via 5 s DB poll until wave clears.
- `sprint_handoffs` table (`schema.ts:513`) — per-wave context hand-off (file diffs, outputs) between tasks.
- Shared blackboard: Postgres `tasks` table with `FOR UPDATE SKIP LOCKED` — multiple runners safely share work without double-dispatch.
- `sprint_tasks.workerContainerId` (`schema.ts:505`) — container identity per parallel worker.

**What's missing:**

- Sprint model is not exposed as a routine primitive. Cron-triggered tasks enter as single `general` tasks; to spawn a sprint they'd need explicit `projectId` + sprint provisioning in the cron context.
- No first-class generator-critic pattern — `quality-judge.ts` scores post-hoc but output doesn't gate or re-run the task.

---

### 2.8 Learning Loop — EXISTS / gap: NONE

Most mature capability in the system. Full pipeline:

| Stage | Implementation | Schema ref |
|---|---|---|
| Outcome capture | `tasks.qualityScore`, `tasks.outcomeSummary` | `schema.ts:318,328` |
| Score | `packages/agent/src/executor/quality-judge.ts` post-execution | `tasks.confidenceScore` |
| Learning event | `learning_events` table — eventType: reflection_rule \| scl_mutation \| improvement_proposal \| correction_rule | `schema.ts:762` |
| Distill | `agentImprovementLog` — `patternType` (failure_pattern, success_pattern, skill_proposal), `proposedChange`, `applied` bool | `schema.ts:918` |
| Domain aggregates | `plexo_ops_domain_metrics` — weekly `avgQuality` per domain | `schema.ts:788` |
| Durable store | `memory_entries` — hot/active/cold gradient tiers, vector embeddings, `shorthand` compression | `schema.ts:653` |
| Read on next run | Vector search at task start; `packages/agent/src/memory/store.ts` | — |

`plexo-internal` adds `scl/` subsystem (Structured Context Language): inference logging, task expansion, PII scrubbing, cross-app context — the learning loop runs deeper there.

---

### 2.9 Human Surface — PARTIAL / gap: UI

| Surface | Status | Ref |
|---|---|---|
| Define (REST) | EXISTS | `POST /api/cron`, `cron.ts:1` |
| Define (CLI) | EXISTS | `apps/cli/src/commands/cron.ts` — `list`, `get` |
| Define (NL) | EXISTS | `POST /api/cron/parse-nl`, `cron.ts:153` |
| Launch (manual trigger) | EXISTS | `POST /api/cron/:id/trigger` |
| Watch (live session) | MISSING | No SSE/WS step-tail confirmed |
| Steer (inject mid-run) | PARTIAL | Approval gates only (`/api/approvals`) |
| Hub UI (routine mgmt) | MISSING | Hub has browse/ext/skills; no cron/routine page |
| Hub UI (session viewer) | MISSING | Not found |
| Hub UI (approval panel) | PARTIAL | API-backed, dashboard referenced in code (`approvals.ts:90`) |

---

## 3. Verdict

**The dominant gap is UI/UX, not capability.**

The engine is ~80% complete:

- Executor with scoped repos, tool isolation, crash-resume, multi-model routing — production-grade.
- Cron engine with NL parser, manual trigger, CRUD REST API — production-grade.
- Telegram notification — zero work needed.
- Learning loop — the most complete piece; memory survives across runs.
- Multi-agent (sprint/queue/parentId) — exists, not yet a routine primitive.

The three **logic gaps** are small and specific:
1. `cronJobs` schema missing `prompt`, `repoUrl`, `connectorIds`, `notifyChannel` (~1 migration).
2. Connectors are workspace-scoped; no per-routine scoping in dispatch path.
3. GitHub-specific webhook event routing (one route, HMAC + event fan-out).

The **UI gap** is the main work: no routine management page, no session viewer, no live watch surface — the data is all there, it's just not surfaced.

---

## 4. Phased Roadmap to MVP-Harness

**Goal:** one routine runs end-to-end — cron fires → executor clones repo → runs prompt with scoped connectors → completes → notifies via Telegram. Smallest path first.

### Phase 0 — Schema (½ day)

Add to `cronJobs` table (one migration):

```sql
ALTER TABLE cron_jobs
  ADD COLUMN prompt        text,
  ADD COLUMN repo_url      text,
  ADD COLUMN branch_ref    text DEFAULT 'main',
  ADD COLUMN connector_ids text[] DEFAULT '{}',
  ADD COLUMN notify_channel text;  -- 'telegram:<chatId>' | 'email:<addr>'
```

Refs: `packages/db/src/schema.ts:633`, migrations dir.

### Phase 1 — Dispatch Bridge (1–2 days)

In `cron-dispatch.ts`, when pushing a cron-triggered task:

- Read `taskContext.prompt`, `taskContext.repoUrl`, `taskContext.connectorIds` from cron row.
- Pass as `ExecutionContext` fields so the executor receives a pre-populated user message and scoped connector list.
- Clone `repoUrl` to a temp workdir (reuse sprint clone logic from `executor/index.ts:1136`) and set `ctx.sprintWorkDir`.

No new packages needed; wire existing sprint clone + connector bridge into the cron dispatch path.

### Phase 2 — GitHub Event Routing (1 day)

New route: `POST /api/webhooks/github/:workspaceId`

- Verify `X-Hub-Signature-256` (HMAC-SHA256, secret per workspace).
- Parse `X-GitHub-Event` → map push/pull_request/issues → cron-style task push with `source: 'github'` and structured context.
- Event filter stored in `taskContext` of a new `event_trigger` taskType on the cronJobs row (or a separate `webhookTriggers` table if cleaner).

### Phase 3 — Hub Routine Page (2–3 days)

New page: `/app/routines` in the web app (where `/app/approvals` already lives, not in hub marketplace).

- List view: name, schedule (human-readable), last run status, next run.
- Create/edit form: name, cron expression (with NL input → parse-nl), prompt textarea, repo URL + branch, connector multi-select (from installed connections), notify channel.
- Wire to existing `/api/cron` CRUD endpoints — no new backend needed.

### Phase 4 — Watch + Steer (2 days)

- **Watch:** SSE endpoint `GET /api/tasks/:id/steps/stream` — push new `task_steps` rows as they're written. Front-end step timeline component.
- **Steer:** `POST /api/tasks/:id/inject` — append a user message to the running task's step context (needs one-line executor hook at the top of the step loop to drain a pending-messages queue).
- Telegram: post step summary + "✓ / ⚠ approve?" button on routine completion, deep-link to session viewer.

---

## 5. Open Architecture Decisions (escalate, don't decide)

1. **Plexo executor vs Claude Code subprocess** — CC gives CLAUDE.md inheritance, native git tools, and CC session IDs for the routines UI; Plexo's executor gives model flexibility and cost control. Mixing both (CC for code tasks, Plexo loop for chat/ops tasks) is possible but adds dispatch complexity.

2. **Per-routine connector scoping** — JSONB array in `cronJobs.connector_ids` (simple) vs a `cron_job_connectors` FK join table (queryable, UI-picker friendly, but adds migration + join). Decision determines how complex Phase 1 dispatch bridge is.

3. **GitHub trigger: OAuth token vs GitHub App** — OAuth token is user-scoped and simpler; GitHub App supports org-wide installation, fine-grained permissions, and webhook secret rotation without re-auth. App is the right long-term choice but adds setup overhead.

4. **Watch surface: SSE vs WebSocket** — SSE is one-directional (log tail) and matches the existing `emitToWorkspace` pattern in the API; WebSocket is bidirectional (needed for steer). Hybrid: SSE for watch, a separate POST endpoint for inject.

5. **Steer mechanism** — Mid-run message injection (modify the executor's step loop) vs pre-run context append (simpler, loses interactivity after task starts) vs Telegram-button approval gate (already works via escalation). All three can coexist; the question is which to build first.

6. **Memory namespace for routines** — `memory_entries` is currently workspace-scoped. Should a routine accumulate its own memory namespace (routine-specific learning) or inherit workspace memory? Routine-scoped namespace is safer (no cross-contamination) but requires a `namespace` column addition and retrieval filter.

7. **Hub marketplace vs web app `/app/routines`** — Hub (`apps/hub`) is the extension marketplace. The dashboard (`apps/web/src/app/`) already hosts approvals, tasks, sprints. Routine management fits better alongside dashboard features than marketplace browsing. But Hub is public-facing and could surface community routine templates.

---

*Audit is read-only. No files were modified outside this document and progress.md.*
