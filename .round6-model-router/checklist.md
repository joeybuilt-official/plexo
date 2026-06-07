# Plexo Round-6 — Model-level router — checklist

## Operator gate (kickoff)
- [x] Objective default: **quality-first (cost tiebreaker)** [2026-06-06]
- [x] User-model precedence: **explicit choice always wins; auto only when no per-task override** [2026-06-06]
- [x] Candidate source: **(configured ∪ discovered) ∩ models_knowledge** [2026-06-06]
- [x] Approve plan — **APPROVED, start Phase 0** [2026-06-06]

## Phase 0 — Candidate model + capability foundation ✅ 2026-06-06
- [x] ModelCandidate type + capability-derivation (strengths[] + manifest Capability + quirks → normalized set) + unit tests — candidate.ts + candidate.test.ts (12 tests green)
- [x] Explore: models_knowledge coverage per connected provider + discovery path inventory; report gaps — phase0-coverage-report.md
- [x] confirm router_v2_stats is model-keyed — CONFIRMED (workspace,provider,model,task_type)
- [x] no behavior change — new files only, nothing imports them; tsc green

## Phase 1 — Candidate enumeration + capability gate (shadow/log-only)
- [x] pure enumerateModelCandidates (capped; configured + discovered ∩ knowledge; pins configured) — enumerate.ts
- [x] capabilityGate hard filter; never empties to a block (single-provider rule) — enumerate.ts
- [x] tests + tsc green (enumerate.test.ts 10 tests; full router-v2 suite 109 green)
- [x] shadow log: emit would-pick vs served to routing_events; served model UNCHANGED — shadow.ts + telemetry.ts (shadow_model_choice on served row, fire-and-forget)
- [x] flag PLEXO_MODEL_ROUTER (default OFF) gates shadow logging — isModelRouterEnabled()
- [x] migration: add shadow_model_choice column to routing_events — 0130_routing_events_shadow.sql
- [x] code tests + tsc green — shadow.test.ts 9 tests; full router-v2 suite 118 green
- [ ] migration applied to prod plexo DB (BEFORE recreate)
- [ ] deployed (build+recreate plexo-api); prod shadow logs show would-pick vs served

## Phase 2 — Weighted scorer + selector integration ⚠ behavior (flag-gated)
- [ ] scoreModelCandidate over {task-fit prior, live stats success/p95, reliability, cost} w/ objective weights
- [ ] selectModel returns best MODEL when flag ON; flag OFF byte-identical to today
- [ ] explicit per-task override always wins; single-provider degrade-and-proceed preserved; D2 modelIdOverride path intact
- [ ] tests (flag OFF identical; flag ON capability+score-best; single-provider; override wins) + tsc green; deployed (flag OFF)

## Phase 3 — Model-granular cascade + per-task capability requirements ⚠ behavior
- [ ] cascade advances across ranked model shortlist (capped, ordered), not just providers
- [ ] per-taskType capability requirements feed the gate (vision/json-strict/min-context)
- [ ] bounded fan-out; never excludes last/only candidate (single-provider); retry-same preserved
- [ ] tests + tsc green; deployed (flag OFF)

## Phase 4 — Telemetry + A/B scorecard
- [ ] routing_events extended w/ chosen-candidate context (shortlist + why)
- [ ] scorecard (Welch via routingScorecard) model-router vs baseline: quality/cost/latency per task
- [ ] new table (if any) added to runDataRetention()
- [ ] tests + tsc green; deployed

## Phase 5 — Measured flip ⚠ operator GO
- [ ] sufficient shadow samples accrued
- [ ] operator GO; set PLEXO_MODEL_ROUTER=1 + recreate (no rebuild)
- [ ] observe scorecard + errors ~1h+; record measured keep/revert decision
