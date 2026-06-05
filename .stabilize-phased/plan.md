# Plexo Stabilization — Master Plan

> 2026-06-04. Prod = the server; app `app.getplexo.com`, api `plexo-api`, saas `plexo-saas`. Deploy = push → fast-forward `/srv/plexo/source/plexo` → `docker compose build` → `up -d` → verify. Planning content is full English per the phased-plan skill (caveman exemption); conversational chat stays caveman.

## Goal
Make Plexo reliably take a real request ("build me a flappy bird game") and execute it end-to-end — correct task vs chat routing, no false timeouts, no schema-driven task failures, with the operator able to *see* provider/task health — and hold the operator principle: **function on a minimum of one modest model, scale gracefully to twenty; resilience must not depend on provider diversity.**

## Audit — root causes (from 4-agent investigation, file:line)

1. **Task vs chat misrouting (THE flappy-bird cause).** `apps/api/src/routes/chat.ts:704-708` — the heuristic pre-classifier marks any message ending in `?` as `CONVERSATION`, regardless of task verbs. "Build me a flappy bird game?" → ends in `?` → CONVERSATION → text-only reply, no task queued, no artifact. The LLM classifier (`chat.ts:725-736`, which would say TASK/PROJECT) is short-circuited and never runs. Highest user-visible leverage; surgical.
2. **False "Request timed out or lost connection".** `chat.ts` does blocking work *before* `res.flushHeaders()` (~line 921): memory recall (`~639`, 2-5s), LLM intent classify (`725-736`, ~10s), workspace snapshot (`864-868`), tools hydration (`906-910`). No early flush, no SSE heartbeat/keepalive while the model thinks → Cloudflare tunnel / browser drops the idle connection (~60s). Client (`apps/web/src/app/app/chat/page.tsx:915`) has no explicit timeout and a broad `catch` (`~1093`) that renders any error as "timed out". No inactivity timeout on the SSE reader (`947-1005`).
3. **Structured-output task failures.** Planner Zod schemas demand strict shapes weak models can't reliably emit. `oneWayDoors` requires `type` (enum) + `reversibility` + `requiresApproval` (`packages/agent/src/planner/index.ts:~55-72`); missing fields → Zod `invalid_union` → `RouterV2CallError` → `task.failed`. `callModel` repair path (`packages/agent/src/providers/call-model.ts:~709-850`) doesn't fence-rescue *repair* output; executor (`packages/agent/src/executor/index.ts:~838-841`) consumes `oneWayDoors` with no coercion. **Note (safety):** `oneWayDoors` is a guardrail — it gates destructive/irreversible actions for approval. Relaxation must default to the SAFE side, never the permissive side.
4. **Observability blind spots.** Router-v2 stats are in-memory only, reset every deploy (`packages/agent/src/providers/router-v2/stats.ts:128` "TODO Phase 5"). Telemetry `emitRoutedEvent` is a `console.info` stub (`telemetry.ts:57-60`). No provider-failure alert path (Telegram exists for task delivery only; no SMTP). Foundation does exist: `plexo_ops_errors` + `trackError`, `plexo_ops_analytics` + analytics events, weekly `digest-worker.ts`, `/health` with per-provider auth tracking.

## OSS benchmark (first principles)
- **Vercel AI SDK streaming** — stream the response shell immediately; send keepalive/`:ping` comments; never block the HTTP response on pre-work. Principle: *time-to-first-byte ≠ time-to-first-token*; flush headers first.
- **LangGraph / agent runtimes** — long agent runs emit **incremental node/step events**; clients render progress, not a spinner-to-timeout. Principle: *stream progress, not just the final answer*.
- **OpenAI/Anthropic structured output** — treat structured output as best-effort with **repair + lenient parse + safe defaults**, not all-or-nothing validation. Principle: *coerce at the boundary; fail closed only on safety-critical fields*.
- **Router/proxy patterns (LiteLLM)** — per-provider health + retries-then-fallback, with persisted call stats. Principle: *observability is part of the router, not an afterthought*.
- Deliberate deviation: Plexo keeps a fast heuristic pre-classifier (cost), but we make it **fail toward the LLM classifier**, not toward CONVERSATION.

## Expert panel — conflicts to ESCALATE (operator decides; not resolved here)

- **Safety (Mateo) vs Resilience (Riya).** Riya: relax `oneWayDoors`/planner schemas (optional + defaults) so modest models complete tasks. Mateo: `oneWayDoors` is the destructive-action approval gate — careless defaults (`requiresApproval=false`, lenient `type`) could let irreversible ops run unapproved. **ESCALATE.** Lean: missing/!valid safety fields default to the SAFE side (`requiresApproval=true`, treat unknown as needing approval); relaxation never widens what executes without approval.
- **Performance (Dev) vs Reliability (Sam).** Sam: heartbeat + raised timeouts so the connection survives. Dev: a 53s wait is *real* latency (serial pre-stream work) — masking it with keepalive is lipstick; parallelize/precompute and flush early. **ESCALATE.** Lean: do both — heartbeat to stop false failures AND parallelize pre-stream work + flush headers before it.
- **Correctness (Lena/UX) vs Cost (Omar/Maint).** Omar: the heuristic exists to avoid an LLM classify call on every message (cost/latency). Lena: the heuristic is wrong often enough to break the core promise. **ESCALATE.** Lean: keep heuristic for *unambiguous* cases, but route ambiguous/build-verb cases to the LLM classifier instead of defaulting CONVERSATION.
- **Observability (Priya) vs Performance (Dev).** Priya: persist provider call-stats. Dev: per-call DB writes add latency to the hot path. **ESCALATE.** Lean: batched snapshot cron (e.g. every 30-60 min) + event emit on failure only — never a synchronous write per call.

## Pre-mortem (assume it failed) + fallbacks → ADR 0001
1. **Schema relaxation masks real planning errors / weakens safety gate.** Fallback: safe-side defaults only; keep a `planner.schema_relaxed` telemetry counter so we see how often it fires; never default `requiresApproval` to false.
2. **Streaming/heartbeat changes break chat rendering or double-emit.** Fallback: gate behind an env flag (`PLEXO_CHAT_HEARTBEAT`), validate on a throwaway/e2e conversation before prod, keep the old path one revert away.
3. **The model is simply too weak** — even with all fixes, gpt-oss-120b/deepseek-flash can't do agent coding tasks. Fallback: the system must *degrade honestly* — a clear "this model couldn't complete the task" with the option to enable a stronger model — never a silent timeout or a fake success. (Operator can enable Anthropic on demand; not required for the system to behave correctly.)

## Phases

## Phase 1 — Task vs chat routing correctness
- Scope: Fix `chat.ts` intent heuristic so trailing `?` does not override task verbs; route unambiguous build/coding requests to TASK/PROJECT; on ambiguity fall through to the LLM classifier instead of defaulting CONVERSATION. Add a regression test for "build me a flappy bird game?" → TASK.
- Deps: none
- Subagents: none (surgical, ≤2 files)
- Exit: unit test proves build-verb questions classify as TASK/PROJECT; deploy; live "build …?" spawns a task (not a chat reply).
- Status: DONE (session 1) — `chat-intent.ts` pure helper + `?`-only-without-task-verb fix + fail-toward-execution; 7 tests; shipped `34b596b`, api deployed. Live verify of an actual build-task run folded into Phase 5.

## Phase 2 — Streaming: kill false timeouts
- Scope: Flush SSE headers before the blocking pre-work; emit an early `status` event + periodic `:heartbeat` keepalive while the model works; parallelize independent pre-stream work (memory recall ∥ snapshot ∥ tools) where safe; add an explicit client `AbortSignal` aligned to server budget + stop masking all errors as "timed out" + SSE inactivity handling. Gate behind `PLEXO_CHAT_HEARTBEAT` per pre-mortem #2.
- Deps: none (independent of P1)
- Subagents: general-purpose for the client+server edits if large
- Exit: a deliberately-slow request keeps the connection alive (heartbeat observed), shows progress, and never shows a false "timed out" before ~the real budget; deploy + live verify.
- Status: DONE server-side (session 1) — SSE `: keepalive` heartbeat (gated `PLEXO_CHAT_HEARTBEAT`, kill switch `=false`) + 12s classification total-budget cap; shipped `2050bf5`, api deployed. DEFERRED Phase 2b (saas client): explicit AbortSignal + stop rendering all errors as "timed out" + SSE inactivity handling (server heartbeat addresses the root idle-drop; client is polish).

## Phase 3 — Structured-output resilience (safe-side)
- Scope: Make planner schemas tolerant — optional + **safe defaults** for non-safety fields, SAFE-side defaults for `oneWayDoors` (unknown ⇒ requiresApproval=true); add fence-rescue to the `callModel` repair path; executor-side normalization/coercion of `oneWayDoors`. Add `schema_relaxed` telemetry. Tests for partial/malformed planner JSON → task proceeds safely.
- Deps: none (independent), but validated together in P5
- Subagents: general-purpose for edits + tests
- Exit: tests show a weak-model partial-JSON plan completes (not task.failed) AND a missing `requiresApproval` defaults to true (safety preserved); deploy.
- Status: DONE (session 1) — `OneWayDoorSchema` per-field `.catch()` safe defaults, `requiresApproval` fails CLOSED; 6 tests; shipped `21211f7`, api deployed. DEFERRED: `call-model.ts` repair-path fence-rescue + `schema_relaxed` telemetry (planner coercion already stops the observed task.failed).

## Phase 4 — Observability + alerting
- Scope: Persist router-v2 stats (new additive `router_v2_stats` migration + a snapshot cron reading `getAllStats()`); emit provider-failure events to `plexo_ops_analytics` on cascade-exhaust / repeated auth/quota; a batched provider-unreliable + canary-FAILED alert via the existing Telegram delivery path; wire the onboarding canary result into an event (not just stdout).
- Deps: none (additive); migration is a no-op-safe forward migration
- Subagents: general-purpose for the table + cron + alert wiring
- Exit: `router_v2_stats` populated by the snapshot job on a throwaway DB; a simulated provider-failure streak produces an alert event; deploy.
- Status: pending

## Phase 5 — End-to-end validation ⚠ operator-gate (real account)
- Scope: Drive the operator's real `app.getplexo.com` — "build me a flappy bird game" + 1-2 more real tasks — via the logged-in browser session. Confirm: correct TASK routing, streaming progress + heartbeat, the task executes and completes (or degrades honestly), no false timeout, no schema task.failed. Confirm observability surfaces the run. Watch live api logs throughout.
- Deps: Phases 1-4
- Subagents: none (driven via Claude-in-Chrome)
- Exit: a real "build flappy bird" request completes end-to-end (or fails honestly with a clear reason), all prior-phase fixes confirmed live.
- Status: pending

## One-way doors ⚠ / operator gates
- Each phase ends in a prod deploy (api and/or saas rebuild + recreate) — reversible via prior image (recorded each time), operator has been authorizing readily this session; still announce host + hostname-gate.
- Phase 3 touches a SAFETY guardrail (`oneWayDoors`) — the safe-side-default decision is an operator sign-off point (see ESCALATE #1).
- Phase 5 drives the real account — operator-gated, read/normal-use only.

## Decisions log
- 2026-06-04 — Plan created post multi-failure session. Ordering = correctness (P1) → UX-timeout (P2) → resilience (P3) → observability (P4) → validate (P5), so the most user-visible break (build-request did nothing) lands first.
