# Plexo Round-6 — Model-level router — checklist

## Operator gate (kickoff)
- [ ] Decide objective default: quality-first (cost tiebreaker) vs cost-first
- [ ] Decide user-model precedence: auto-route only when no explicit override vs full auto-override
- [ ] Decide candidate source: (configured ∪ discovered) ∩ models_knowledge vs catalog-only vs configured-only
- [ ] Approve plan

## Phase 0 — Candidate model + capability foundation
- [ ] ModelCandidate type + capability-derivation (strengths[] + manifest Capability + quirks → normalized set) + unit tests
- [ ] Explore: models_knowledge coverage per connected provider + discovery path inventory; report gaps
- [ ] confirm router_v2_stats is model-keyed (per-model live stats available)
- [ ] no behavior change

## Phase 1 — Candidate enumeration + capability gate (shadow/log-only)
- [ ] pure enumerateModelCandidates (capped; configured + discovered ∩ knowledge)
- [ ] capabilityGate hard filter (vision/json-reliable/min-context); never empties to a block (single-provider rule)
- [ ] shadow log: emit would-pick vs served to routing_events; served model UNCHANGED
- [ ] flag PLEXO_MODEL_ROUTER (default OFF) gates shadow logging
- [ ] tests + tsc green; deployed; prod shadow logs show would-pick vs served

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
