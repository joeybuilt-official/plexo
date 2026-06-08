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

## Phase 5 — Measured flip ⚠ operator GO  ✅ EXECUTED → REVERTED 2026-06-08
- [x] sufficient shadow samples accrued (post-fix): summarization n=407 div 0.5%, extraction n=285, conversation n=24
- [x] operator GO; set PLEXO_MODEL_ROUTER=1 + recreate (06:13 UTC)
- [x] observed → **REVERTED within ~2min**. Regression: model-router routed extraction to groq-hosted gpt-oss-120b → groq strict JSON-schema (`additionalProperties:false must be set on every object`) rejected the request (400, non-retryable → hard fail, no cascade) + groq TPD rate limit (200k tokens/day). Reverted to PLEXO_MODEL_ROUTER=0 (known-good legacy); verified healthy. Reversible via flag — done.
- Measured decision: **REVERT** — groq is the scorer's tiebreak winner for extraction (cost-known + low-latency) but is functionally worse there (strict-schema incompat + TPD cap). The scorer has no signal for these. SHADOW stays ON (data keeps accruing).

## Follow-ups
- [x] error-classifier: classify "invalid JSON schema / additionalProperties / response_format" as fallback-able (parse-malformed → fallback-next) so the cascade moves OFF the strict provider instead of hard-failing — affects legacy too. Commit 7723375 (pushed, NOT deployed). +2 classifier tests.
- [x] manifest: groq modeled strict-not-lenient for json-gated tasks — groq extraction/judging now 'function-calling-strict' (not lenient 'json-mode') + 'groq-strict-json-schema' quirk, so the json-mode gate excludes groq for lenient extraction schemas; lenient gpt-oss hosts (cerebras/ollama_cloud) keep json-mode. +1 manifest invariant test. (NOT deployed.)
- [ ] backfill models_knowledge cost for cerebras/ollama_cloud so the extraction tiebreak reflects real cost (Phase 0: they have 0 knowledge rows → cost unknown → lose ties). Needs real per-token pricing (cerebras public; ollama_cloud managed-pool — pricing model TBD).

## Re-flip readiness — follow-ups DEPLOYED 2026-06-08 ~23:18 UTC
Deployed: #1 classifier cascade-off-strict-schema (7723375), #2 groq strict-json manifest (98d30ac), #2b candidate.ts quirk STRIPS lenient json-mode (1f04207 — necessary because groq's models_knowledge structured_output strength re-derived json-mode; manifest change alone was insufficient). Flag still OFF (ROUTER=0/SHADOW=1).

Post-deploy shadow re-measure (rows since 23:18):
- **extraction: divergence ~0% (n=39), was 75–99%** — groq now gate-excluded (gated 4→3); router routes extraction to cerebras/gpt-oss-120b = the lenient host legacy serves. DANGEROUS case (groq strict-schema hard-fail) RESOLVED.
- summarization: router prefers groq-hosted gpt-oss-120b over cerebras/ollama_cloud-hosted (same model, groq faster + cost-known) — BENIGN (no strict-schema on summarization). Small live sample; historical ~1.5% over n=646.
- conversation: ~12–16% (same benign host preference).
- A/B quality arms still 0 (flag OFF — no post-flip data, expected).

**Readiness:** dangerous divergence resolved; remaining divergence is benign host-shifting to groq for non-structured tasks, with the #1 classifier as a safety net (groq TPD/failure → cascade off). Ready to re-request operator GO for the Phase 5 flip. Note: flipping concentrates summarization on groq → may hit groq TPD (200k/day) at volume, which #1 now cascades gracefully.

## Phase 5 RE-FLIP — EXECUTED 2026-06-08 23:30 UTC (operator GO #2), observing ~1h
Set PLEXO_MODEL_ROUTER=1 + recreate. T+5min: HEALTHY (vs prior flip which failed in 2min).
- extraction → ollama_cloud/gpt-oss:120b (cerebras degraded → cascades cleanly), ALL 200, ZERO groq schema failures (groq gate-excluded as designed).
- summarization → groq/openai/gpt-oss-120b, benign, succeeds (no TPD/schema errors).
- 0 no-candidate; only error = recreate AbortError (transient). model_routed=t rows accruing for A/B.
- NEXT: observe ~1h → record keep/revert (A/B quality once judge scores router-served rows). Instant revert = flag=0 + recreate.

### RE-FLIP REVERTED 2026-06-08 23:43 UTC (2nd revert) — NEW root cause found via real browser test
Browser-driven validation on app.getplexo.com (operator session) sent real web chats. The synthetic proxy calls (extraction/summarization) looked healthy, but the REAL web chat FAILED ("Failed" in UI; POST /api/v1/chat/message → 500).
Root cause: post-flip the model-router pulled high-volume chat/inference traffic OFF the workspace's **local `ollama` primary** (chain: ollama→deepseek→ollama_cloud→cerebras→groq) onto rate-limited CLOUD gpt-oss hosts (deepseek/cerebras/groq) → "Too Many Requests" → mostly cascaded to ollama_cloud ("served by fallback") but SOME terminal-failed (CALL_MODEL_UNKNOWN) → user-facing chat failures. Evidence: 0 such failures in the 90min before flip, 13 after (start 23:34, ramping); stopped immediately on revert (0 after 23:44). Post-revert: chat works, 0 fallback, 0 no-candidate.
The model-router's quality+cost scoring does NOT value the local primary's UNLIMITED/free capacity → it concentrates load on rate-limited cloud providers. This is the blocker, separate from the groq-schema fixes.

### NEW follow-up (blocks any future flip)
- [ ] Model-router must account for local/unlimited-capacity providers. Options: prefer the workspace's configured local primary (ollama) for high-volume non-structured tasks; OR add a capacity/rate-limit-headroom signal to scoring (down-rank providers near their rate/TPD limits); OR keep ollama primary unless it's actually unavailable. Without this, flipping trades the local primary's free unlimited capacity for cloud rate limits → user-facing failures. Re-measure shadow with a capacity-aware scorer before re-attempting Phase 5.
