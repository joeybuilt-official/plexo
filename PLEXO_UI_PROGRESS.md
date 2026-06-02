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
