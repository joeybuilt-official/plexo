# ADR 0006 — Model-level router (select the best model across connected providers)

Date: 2026-06-07
Status: Proposed (awaiting operator gate)
Project: Plexo Round-6 (`/workspace/plexo/.round6-model-router/`)

## Context

Round-5 left the router selecting the best **provider** and calling **one fixed model per provider** (`resolveModelId` precedence: `modelOverrides[taskType]` → `config.model` → `PROVIDER_DEFAULT_MODELS`). The quality manifest (`manifest.ts`) is keyed `TaskType × ProviderKey` — it scores a provider via its *default model class*, not individual models. `models_knowledge` (per-model `context_window`, `cost_per_m_in/out`, `strengths[]`, `reliability_score`, `last_synced_at`) exists but is used only for cost/dashboards — **not wired into routing**. Per-provider model discovery exists (`registry.ts` probes `/v1/models`; the ollama adapter classifies capabilities) but feeds the UI, not the selector.

Goal: a **model-level router** that, per request, picks the most appropriate *model* across all connected providers' catalogs — cheap/fast for classification, strong-reasoning for planning, vision for images, JSON-reliable for extraction — using `models_knowledge` + the manifest + live `router_v2_stats`.

Must preserve: single-provider rule (ADR 0005 — never hard-block), strict-schema compat (ADR 0004), no hardwired provider, cascade/fallback, Round-5 `routing_events` telemetry + scorecards.

## OSS benchmark (first principles)

Surveyed: OpenRouter (price/latency/availability routing), **LiteLLM Router** (explicit model-list + strategies: lowest-latency / usage-based / cost), RouteLLM & NotDiamond/Martian (learned quality/cost routers), Portkey/Vercel AI Gateway (model fallback configs), semantic-router (intent→route).

Distilled principles:
1. **Candidates are models, not providers** — an explicit, enumerable model set.
2. **Hard capability gate before soft scoring** — must-support (vision / json-strict / min-context) filters the set first.
3. **Weighted score** over {task-fit prior, live success/latency, cost, reliability} with a tunable objective.
4. **Fallback operates at model granularity.**
5. **Online stats refine static priors** (we already have `router_v2_stats` per provider×model×task).

Deliberate deviations:
- **No learned/bandit auto-router** — quality risk; keep deterministic capability-gate + weighted score, human-gated flip (same posture as Round-5 ADR 0001 / D2).
- **Reuse `router_v2_stats` + manifest + `models_knowledge`** rather than a new catalog service.
- **Bounded candidate set** (cap N) + cached ranking to hold the <50ms p95 selector budget.

## Expert panel

- **Ada (AI-systems):** candidate enumeration should draw from `models_knowledge` (rich per-model data). *Conflict w/ Dara + Mort.*
- **Dara (Data/DB):** `models_knowledge` may be sparse/stale (`last_synced_at`); routing on it risks selecting a model a provider no longer serves. Prefers candidates restricted to discovered/configured models. *Conflict w/ Ada.*
- **Mort (Maintainability):** a per-model table is heavier to maintain than today's 9×6 provider manifest. Wants the manifest to stay the source of task-fit and `models_knowledge` to only *refine*. *Conflict w/ Ada.*
- **Pat (Performance):** per-request enumeration + scoring must stay <50ms p95. Wants cached per-(workspace,taskType) rankings. *Conflict w/ Maya.*
- **Maya (ML/eval):** wants rich per-model capability + quality scoring (the whole point). *Conflict w/ Pat (latency) + Felix (cost).*
- **Felix (FinOps):** cost-aware routing — cheap models for cheap tasks — could be a default objective. *Conflict w/ Maya (quality-first).*
- **Rey (Reliability):** model-level fallback must not explode the cascade (N models × M providers fan-out under failure). Wants a capped, ordered shortlist. *Conflict w/ Maya.*
- **Uma (UX):** a user's explicitly-chosen model in the UI must be respected or its override shown transparently (the UI badge already mislabels — shows configured, not served). *Conflict w/ Ada (auto-override).*
- **Sasha (Security):** validate model ids from discovery/catalog before use (don't call an attacker-influenced model string). Low conflict.

### Conflicts to escalate (operator decisions — shape the plan)

1. **Default objective: quality-first vs cost-first** (Maya vs Felix). Recommend quality-first with a cost tiebreaker; per-task cost caps for cheap tasks (classification/summarization).
2. **Respect user's configured model vs auto-override** (Uma vs Ada). Recommend: auto-route only when no explicit per-task `modelOverride` is set; an explicit choice always wins. Auto-routing fills the gap, never overrides intent.
3. **Candidate source** (Ada vs Dara vs Mort): curated `models_knowledge` ∪ provider-configured/discovered models, gated to models the connected provider can actually serve. Recommend: candidates = (configured model + discovered models for connected providers) ∩ `models_knowledge` for capability/cost data; manifest provides task-fit prior by class.

## Pre-mortem (3 failures + fallback)

1. **Stale/incomplete `models_knowledge` → router picks a model the provider won't serve → call fails.** Fallback: capability-gate + restrict candidates to configured/discovered models; always keep `config.model` as a candidate; model-level cascade + the existing repair path catch a bad pick; flag-gated default OFF.
2. **Latency blowup (enumerate+score > 50ms p95).** Fallback: cache per-(workspace,taskType) ranked shortlist, refreshed on the stats-snapshot cadence; cap candidate count; selector stays pure + memoized.
3. **Quality regression (auto-pick worse than the user's model).** Fallback: behind `PLEXO_MODEL_ROUTER` flag, default OFF; shadow/log-only first (log what it *would* pick vs current); measure quality delta via `routing_events` + `qualityScore` scorecard; human-gated flip like D2; instant env rollback.
