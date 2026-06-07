# Plexo Round-6 — Model-level router — Master Plan

Date: 2026-06-07. Project root `/workspace/plexo/.round6-model-router/`. Repo `/workspace/plexo` (public, joeybuilt). Prod = the server compose `/srv/plexo`; deploy = git-apply overlay patch → `docker compose build plexo-api` → `up -d --no-deps`, hostname-gated + announced. Migrations applied to prod `plexo` DB (plexo-postgres) **BEFORE** recreate (Round-5 lesson — see memory reference_plexo_deploy_migrations). main @ `a520e81`, prod plexo-api img `73550e59`.

Carries Round-5 discipline: unit tests + `tsc` green before deploy; flag-gated behavior changes default OFF; log/DB-based prod verification; caveman artifacts; NO hardwired provider; single-provider rule (ADR 0005) + strict-schema compat (ADR 0004) preserved.

## Goal
Upgrade router-v2 from provider-selection-with-one-fixed-model to a model-level router that, per request, selects the most appropriate model across all connected providers' catalogs — capability-gated, quality+cost+live-stats scored — without breaking single-provider, strict-schema, cascade, or the no-hardwired-provider rule; shippable, measurable, reversible.

## Open operator decisions (from ADR 0006 — gate these before/at kickoff)
1. **Objective default**: quality-first (cost tiebreaker) [recommended] vs cost-first.
2. **User-model precedence**: auto-route only when no explicit per-task override; explicit choice always wins [recommended] vs full auto-override.
3. **Candidate source**: (configured ∪ discovered models for connected providers) ∩ `models_knowledge` for capability/cost [recommended] vs catalog-only vs configured-only.

These shape Phases 1–3. Recommended defaults assumed in the plan; operator may override.

---

## Phase 0 — Candidate model + capability foundation (data)
- Scope: define a `ModelCandidate` type ({provider, modelId, capabilities, contextWindow, costPerMIn/Out, reliability, priorScore-by-task}); a per-model **capability** derivation (map `models_knowledge.strengths[]` + manifest `Capability` + provider quirks → a normalized capability set); validate/backfill `models_knowledge` rows for the providers actually connected in prod (audit coverage; flag gaps). No selection logic yet. Confirm `router_v2_stats` is already model-keyed (it is) so per-model live stats exist.
- Deps: none. Subagents: Explore to inventory `models_knowledge` coverage + the discovery path (`registry.ts` `/v1/models`, ollama adapter) for connected providers.
- Exit: `ModelCandidate` + capability-derivation unit-tested; a read-only report of model coverage per connected provider (gaps named). No behavior change.
- Status: DONE 2026-06-06 — candidate.ts (ModelCandidate + deriveCapabilities + buildModelCandidate) + candidate.test.ts (12 tests green); tsc clean; phase0-coverage-report.md. Key gaps: cerebras/ollama/ollama_cloud have 0 knowledge rows (graceful-degrade path covers them); context_window hardcoded 128000 for ALL rows (long-context must come from manifest caps, not knowledge). router_v2_stats model-keyed confirmed.

## Phase 1 — Candidate enumeration + capability gate (pure, shadow/log-only)
- Scope: a pure `enumerateModelCandidates({workspaceId, taskType, settings})` → capped candidate list (configured + discovered ∩ knowledge), and a `capabilityGate(taskType, requirements, candidates)` hard filter (e.g. vision tasks → vision-capable only; extraction → json-reliable; min-context). Wire it **shadow/log-only**: alongside today's selection, compute what the model-router *would* pick and emit it to `routing_events` (a `shadow_model_choice` column/field) — do NOT change the served model. Flag `PLEXO_MODEL_ROUTER` (default OFF) controls whether shadow logging runs.
- Deps: Phase 0. Subagents: general-purpose for the enumerate/gate + tests.
- Exit: unit tests for enumeration + gate (incl single-provider: candidate set never empties to a block); prod shadow logs show would-pick vs served for ≥1 of each task type; served model unchanged; tsc green; deployed.
- Status: DONE 2026-06-07 — enumerate.ts + capabilityGate (10 tests), shadow.ts (11 tests, full suite 118 green), migration 0130, telemetry+index wiring. Deployed to the server prod (rebuild+recreate); migration applied before recreate; PLEXO_MODEL_ROUTER_SHADOW=1, serving PLEXO_MODEL_ROUTER=0. Verified in prod on extraction + summarization (served unchanged = cerebras/ollama_cloud; shadow would-pick = deepseek/deepseek-v4-flash, full shortlist logged). Note: shadow consistently prefers deepseek (highest manifest prior among this ws's providers) — whether that's actually better is exactly what Phase 4 scorecard will measure. Mid-deploy bug fixed: drizzle `sql` renders JS array as a record so `ANY(${arr})` threw + was swallowed → switched fetchKnowledge to inArray.

## Phase 2 — Weighted model scorer + selector integration (flag-gated) ⚠ behavior
- Scope: a `scoreModelCandidate` over {task-fit prior (manifest class), live `router_v2_stats` success/p95 per model, reliability, cost} with the operator's objective weights; integrate into `selectModel` so that when `PLEXO_MODEL_ROUTER=1` the selector returns the best **model** (not just provider+default-model), honoring user explicit overrides (decision #2). Preserve single-provider degrade-and-proceed (ADR 0005) + the modelIdOverride/D2 path. Default OFF = byte-identical to today.
- Deps: Phase 1. Subagents: general-purpose.
- Exit: tests: flag-OFF identical to current selection; flag-ON picks capability+score-best model; single-provider still serves; explicit override still wins; tsc green; deployed (flag still OFF in prod).
- Status: DONE 2026-06-07 — score.ts (modelQualityScore + selectBestModel, quality-first/cost-first, cooling pool, unknown-cost-last) + flags.ts (db-free) + selector.ts flag-gated branch (explicit-override + D2 precedence preserved, synthetic entry for unmanifested) + index.ts (loadModelCandidates, buildModel uses chosen model for model-routed) + shadow now uses the real scorer. Tests 23 new; router-v2 132 green; tsc clean. Deployed flag-OFF to prod; verified serving unchanged + shadow scorer-driven (live stats already shifted would-pick groq vs deepseek — prior-refined-by-stats working). routeAndBuild also wired (consistent at flip). Objective default quality-first; PLEXO_ROUTING_OBJECTIVE can switch to cost-first.

## Phase 3 — Model-granular cascade + per-task capability requirements ⚠ behavior
- Scope: extend the cascade (`router-v2/index.ts`) so fallback advances across the ranked model shortlist (capped, ordered) not just providers; define per-taskType capability requirements (vision/json-strict/min-context) feeding the Phase-1 gate; ensure cascade never fans out unboundedly (Rey) and never excludes the last/only candidate (single-provider rule).
- Deps: Phase 2. Subagents: general-purpose.
- Exit: tests: a failing top model cascades to the next ranked model (same or other provider); bounded attempts; single-provider retry-same preserved; tsc green; deployed (flag OFF).
- Status: pending

## Phase 4 — Telemetry + A/B scorecard (measure before flip)
- Scope: extend `routing_events` with the chosen-candidate context (shortlist + why); a scorecard reusing the Round-5 Welch `routingScorecard` to compare `qualityScore` (and cost/latency) of model-router choices vs baseline per task type; add any new table to `runDataRetention()`.
- Deps: Phases 1–3 (shadow + flag data). Subagents: general-purpose.
- Exit: scorecard returns per-task model-router-vs-baseline quality/cost/latency deltas with sample counts; tsc green; deployed.
- Status: pending

## Phase 5 — Measured flip (operator GO) ⚠ one-way-ish / operator gate
- Scope: with the Phase-4 scorecard live + shadow data accrued, flip `PLEXO_MODEL_ROUTER=1` (env + recreate, no rebuild); observe scorecard + lane gauge + error rates ~1h+; decide keep/revert. Operator-gated GO (quality + cost bar).
- Deps: Phase 4 + sufficient shadow samples. Subagents: none.
- Exit: a recorded measured decision (keep with quality/cost delta within bar, or revert). Reversible via the env flag.
- Status: pending

## One-way doors / operator gates (summary)
- Objective / user-precedence / candidate-source decisions (kickoff) — operator.
- Phase 2 ⚠ behavior (flag-gated, default OFF) — verify flag-OFF identical.
- Phase 3 ⚠ behavior (cascade semantics, flag-gated).
- Phase 5 ⚠ operator GO (quality+cost) — measured flip.

## Deploy/verify recipe (every code phase)
1. commit + push (within standing OK).
2. `git diff <prev> <head> -- packages apps` → copy to the server → `git apply` in `source/plexo` (dry-run `--check` first).
3. migrations (if any): apply SQL to prod `plexo` DB BEFORE recreate.
4. `docker compose build plexo-api` → `up -d --no-deps plexo-api` → wait healthy.
5. verify via logs/DB; flag stays OFF until Phase 5.

## Decisions log
- 2026-06-07 — Phase 1 flag split (refinement). A single PLEXO_MODEL_ROUTER cannot both gate observe-only shadow logging (Phase 1) AND flip serving (Phase 5): once Phase 2 wires serving to that flag, turning it on to collect shadow data would also change serving. Split: **PLEXO_MODEL_ROUTER_SHADOW** = observe-only shadow logging (safe ON in prod, Phases 1–4); **PLEXO_MODEL_ROUTER** = serving flip (Phase 5, implies shadow too). Resolves the plan's internal contradiction (Phase 1 wants prod shadow data while flag stays OFF). Phase 2 selector integration gates on PLEXO_MODEL_ROUTER only.
- 2026-06-06 — Phase 0 DONE. Capability foundation built (no behavior change, nothing imports it yet). Coverage audit surfaced two facts that constrain later phases: (1) 3/6 connected providers (cerebras, ollama, ollama_cloud) have NO models_knowledge — design's graceful-degrade (caps from manifest, cost/ctx=0) is load-bearing, not optional; (2) context_window is a hardcoded 128000 default everywhere, so Phase-1 min-context gate must treat 128000/0 as "unknown" and rely on manifest long-context caps.
- 2026-06-06 — Operator gate PASSED. Decisions: (1) objective = quality-first w/ cost tiebreaker + per-task cost caps for cheap tasks; (2) user-precedence = explicit per-task modelOverride always wins, auto-route only fills the gap; (3) candidate source = (configured ∪ discovered for connected providers) ∩ models_knowledge, manifest gives task-fit prior. Plan APPROVED — Phase 0 started. Flag PLEXO_MODEL_ROUTER stays OFF until Phase 5.
- 2026-06-07 — Plan created (phased-plan skill). Audit: router selects provider + one fixed model/provider; manifest provider×task; models_knowledge per-model data unused in routing; per-provider discovery exists. ADR 0006 written w/ expert panel + 3 operator conflicts (objective, user-precedence, candidate-source). Awaiting operator gate.
