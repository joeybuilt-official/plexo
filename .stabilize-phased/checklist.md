# Plexo Stabilization — checklist

## Phase 1 — Task vs chat routing correctness
- [x] Fix trailing `?` no longer forces CONVERSATION when a task verb is present (extracted to pure `chat-intent.ts`)
- [x] Unambiguous build/coding requests defer to LLM classifier (route to execution)
- [x] Ambiguous cases fail TOWARD execution on classifier failure/unknown (not default CONVERSATION)
- [x] Regression test: "Build me a flappy bird game?" → needsLlm(hasTaskVerb) — 7 tests pass
- [~] Deploy api + live-verify a build request spawns a task (build running, recreate pending)

## Phase 2 — Streaming: kill false timeouts
- [x] SSE keepalive heartbeat during model work (gated `PLEXO_CHAT_HEARTBEAT`, kill switch =false) — prevents Cloudflare/browser idle drop
- [x] Bound classification to a 12s total budget (caps the 53s cascade+retry stack) → fail toward execution on overrun
- [x] Deploy — shipped `2050bf5`, api recreated
- [ ] DEFERRED Phase 2b (saas): client explicit AbortSignal + stop rendering all errors as "timed out" + SSE inactivity handling. Server heartbeat addresses the root (idle SSE drop); client polish is secondary.

## Phase 3 — Structured-output resilience (safe-side)
- [x] `oneWayDoors`: per-field `.catch()` SAFE defaults — partial/malformed object coerces instead of failing the plan; `requiresApproval` fails CLOSED (defaults true)
- [x] Tests: partial object → safe defaults; missing requiresApproval ⇒ true; invalid type → state_change; string/number forms (6 tests)
- [x] Deploy — shipped `21211f7`, api recreated (image d31656412475)
- [ ] DEFERRED: fence-rescue on the `callModel` repair path (`call-model.ts`) + `schema_relaxed` telemetry counter. Planner coercion already prevents the observed task.failed; these are deeper robustness for other structured calls.

## Phase 4 — Observability + alerting
- [ ] `router_v2_stats` additive migration + `getAllStats()` export
- [ ] Snapshot cron persists stats (survives deploys)
- [ ] Provider-failure events → `plexo_ops_analytics` (cascade-exhaust / repeated auth/quota)
- [ ] Batched provider-unreliable + canary-FAILED alert via Telegram delivery path
- [ ] Onboarding canary result emits an event (not just stdout)
- [ ] Validate on throwaway DB; deploy

## Phase 5 — End-to-end validation ⚠ operator-gate (real account)
- [ ] Drive real "build me a flappy bird game" via browser session
- [ ] Confirm: TASK routing, streaming + heartbeat, executes + completes (or honest degrade), no false timeout, no schema task.failed
- [ ] Confirm observability surfaces the run
- [ ] 1-2 additional real task flows
