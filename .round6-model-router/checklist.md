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
- [x] migration applied to prod plexo DB (BEFORE recreate) — routing_events.shadow_model_choice live
- [x] deployed (build+recreate plexo-api); shadow flag wired (PLEXO_MODEL_ROUTER_SHADOW=1, serving PLEXO_MODEL_ROUTER=0)
- [x] prod shadow logs show would-pick vs served — verified extraction + summarization (served cerebras/ollama_cloud; shadow deepseek/deepseek-v4-flash; full shortlist + model.shadow log line). Bug fixed mid-deploy: drizzle array-binding (inArray) — see plan decisions log.

## Phase 2 — Weighted scorer + selector integration ⚠ behavior (flag-gated)
- [x] scoreModelCandidate over {task-fit prior, live stats success/p95, reliability, cost} w/ objective weights — score.ts (modelQualityScore + selectBestModel; quality-first default, cost-first via PLEXO_ROUTING_OBJECTIVE; unknown-cost-last; cooling pool)
- [x] selectModel returns best MODEL when flag ON; flag OFF byte-identical — selector.ts flag-gated branch; equivalence suite unchanged
- [x] explicit per-task override always wins; single-provider preserved; D2 modelIdOverride intact — selector-model-router.test.ts
- [x] index.ts: loadModelCandidates when flag ON; buildModel uses chosen model for model-routed picks; shadow uses real scorer (provisionalPick removed)
- [x] tests + tsc green — score(10)+selector-model-router(6)+shadow(7); full router-v2 132 green
- [x] deployed (flag OFF in prod) — rebuilt+recreated; ROUTER=0/SHADOW=1; verified serving unchanged (legacy cerebras) + shadow now scorer-driven (reason "scored", live stats shifted would-pick groq vs deepseek)

## Phase 3 — Model-granular cascade + per-task capability requirements ⚠ behavior
- [x] cascade advances across ranked model shortlist, not just providers — index.ts excludedModels; provider dropped only when its models exhausted; bounded by MAX_CASCADE
- [x] per-taskType capability requirements feed the gate — requirementsForTask (extraction/judging→json-mode); vision deferred (request-intrinsic) + min-context deferred (context_window unreliable)
- [x] bounded fan-out; never excludes last/only candidate (single-provider); retry-same preserved (retry-same path untouched)
- [x] tests + tsc green — requirementsForTask + gate (enumerate.test); model-granular cascade (model-cascade.test); router-v2 137 green
- [x] deployed (flag OFF) — rebuilt+recreated; verified serving unchanged + gate live (extraction json-mode req narrowed shadow shortlist 4→1, only groq passed)

## Phase 4 — Telemetry + A/B scorecard
- [x] routing_events extended w/ chosen-candidate context — shadow_model_choice (chosen+prior+shortlist+reason, Phase 1) + model_routed marker (0131)
- [x] scorecard model-router vs baseline — modelRouterScorecard: shadow divergence (pre-flip) + served-quality A/B Welch per task type
- [x] no new table — routing_events already pruned by cron runDataRetention (cron.ts:194); model_routed is a column
- [x] tests + tsc green — model-router-scorecard.test (3); router-v2+eval 165 green
- [x] deployed — migration 0131 applied; rebuilt+recreated; verified model_routed persists (f, flag off) + scorecard runs on live prod data (extraction div 98%, summarization 25%, conversation 14%; A/B arms 0 pre-flip)

## Pre-Phase-5 — capability-metadata fix (operator chose) ✅ 2026-06-08
- [x] Phase 4 scorecard surfaced extraction 98% divergence = json-mode gate artifact (gpt-oss/deepseek lacked json-mode metadata)
- [x] add json-mode to deepseek/groq/cerebras/ollama_cloud (extraction) + deepseek/ollama_cloud (judging); 137 green; tsc clean
- [x] deployed shadow-only (serving OFF); verified extraction shadow gated 1→4 (gpt-oss now pass); residual divergence is honest cost-tiebreak
- [ ] let shadow re-measure over fresh traffic; re-run modelRouterScorecard before flip

## Phase 5 — Measured flip ⚠ operator GO  (NOT executed — awaiting GO)
- [ ] sufficient shadow samples accrued (post-fix)
- [ ] operator GO; set PLEXO_MODEL_ROUTER=1 + recreate (no rebuild)
- [ ] observe scorecard + errors ~1h+; record measured keep/revert decision
