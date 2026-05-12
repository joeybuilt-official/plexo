# Plexo task-routed best-model selector — master plan

**Goal:** Replace `withFallback()` with a task-routed best-model selector that picks the best installed model per task using a hand-curated quality manifest refined by rolling operational stats, cascades silently on error-class-aware failure, and emits decision telemetry as its primary product.

**Owner:** operator + Claude Code.
**Repo in scope:** `/home/dustin/dev/joeybuilt/plexo`.
**Companion docs:** `adr/0012-task-routed-best-model-selector.md` (deliberation + pre-mortem), `checklist.md` (flat work list).

---

## Phase 0 — Audit + OSS benchmark (COMPLETE)

- Scope: Inventory `withFallback` + chain-resolver + single-model gate; benchmark 5 OSS impls (RouteLLM, NotDiamond, OpenRouter, Portkey, LiteLLM); distill first principles.
- Deps: none
- Context budget: n/a (complete)
- Subagents: n/a
- Exit: audit findings folded into ADR 0012 Context section; OSS pattern taxonomy (A/B/C) documented in ADR.
- Status: **done**

**Key findings folded in:**
- Current `withFallback` ≈ OpenRouter `models[]` — Pattern A with only `fallback` primitive.
- Single-model policy at router.ts:305-333 bypasses chain-resolver + DEFAULT_MODEL_ROUTING; both currently dead code.
- 9 call sites of `withFallback` across `apps/api/src/routes/{inference,chat,ai-complete,vision,chat-app-transport}.ts`, `apps/api/src/channel-ai.ts`, `packages/agent/src/memory/store.ts`.
- TaskType union is finite + stable (8 entries); favors Pattern A over Pattern B (learned classifier).

---

## Phase 1 — Expert panel + ADR + plan + checklist (THIS WORK)

- Scope: 6-expert deliberation (Naia/Iko/Söl/Quill/Sage/Rex), pre-mortem with 3 failure modes + fallbacks, ADR draft, master plan, flat checklist.
- Deps: Phase 0
- Context budget: ≤45%
- Subagents: none (synthesis from prior audit)
- Exit: ADR + plan + checklist on disk; conflicts C1/C2/C3 + operator Qs Q1/Q2 surfaced for the gate.
- Status: **in-progress** (operator gate pending)

⚠ **Operator sign-off gate** — five items require explicit approval before Phase 2:

- **C1** Manifest shape: flat priors (Naia) vs rich capabilities+quirks (Rex)
- **C2** Telemetry granularity: always-on `alternatives_considered` (Quill) vs only-on-fallback (Naia)
- **C3** Auth-failure surface: fully silent (Sage) vs operator-alerted (Söl)
- **Q1** "Best" definition: confirm hybrid (manifest prior + rolling stats, no learned v1)
- **Q2** Workspaces with only low-quality models: silent route + passive nudge vs block-and-prompt

---

## Phase 2 — Router core (behind feature flag)

- Scope: Implement in `packages/agent/src/providers/router-v2/`:
  - `manifest.ts` — rich (TaskType × ModelClass) → ManifestEntry with capabilities + quirks + hardSkipPredicate (operator decision C1: rich)
  - `stats.ts` — per (workspaceId, provider, model, taskType) rolling window (p50/p95 latency, success rate, cooldown end timestamp)
  - `selector.ts` — pure `selectModel({...}) → SelectionResult`; Q2 hybrid (planning/codeGeneration/extraction block on all-low-quality, others route through)
  - `error-classifier.ts` — 8-class branching: rate-limit / auth / context-window / content-policy / transient-5xx / network / quota / unknown
  - `telemetry.ts` — `model.routed` event; alternatives_considered ALWAYS emitted (operator decision C2)
  - `index.ts` — `routeAndCall` public entry (shape-equivalent to withFallback)
  - Feature flag `ROUTER_V2_ENABLED` (default off; renamed from `PLEXO_TASK_ROUTER`)
  - Gated wrapper at existing `withFallback` (defense-in-depth fallback on internal selector/manifest error)
  - TODO comments at 7 call-site files for Phase 4 migration
  - Equivalence tests vs `withFallback` + Q2 hybrid + workspace isolation + selector p95 benchmark
- Deps: Phase 1 operator gate
- Context budget: ≤45%
- Subagents: deferred — task spec carried baseline-facts inline so no inventory subagent needed
- Exit: New router passes unit tests; `withFallback` still in use everywhere (flag default off); CI green.
- Status: **done** — 7 files (~1100 LOC src + tests); 36/36 router-v2 tests pass; typecheck clean; selector p95 ≈ 0.02ms.

---

## Phase 3 — Wire chat-completions endpoint behind flag + equivalence test

- Scope: Migrate `apps/api/src/routes/inference.ts:274` to new router behind `PLEXO_TASK_ROUTER`. Add shadow-mode equivalence test: run both paths in parallel for 24h on a staging workspace, compare chosen provider + latency + error distribution.
- Deps: Phase 2
- Context budget: ≤45%
- Subagents: Explore for inference.ts call graph + downstream contracts (return contract diffs only)
- Exit: Shadow comparison shows new router selects equally-good-or-better in ≥95% of cases on staging; no regressions in latency p95; equivalence report committed.
- Status: pending

⚠ **One-way door:** telemetry schema for `model.routed` finalized here. Downstream dashboards bind to it after this phase.

---

## Phase 4 — Migrate remaining callers (one PR each)

- Scope: One PR per file, behind same flag. **11 source files** (Phase 2 audit revised from 7 — 4 internal callers added):
  - Route handlers:
    - `apps/api/src/routes/chat.ts` (6 call sites: :542, :705, :922, :930, :1047, :1131)
    - `apps/api/src/routes/ai-complete.ts:80`
    - `apps/api/src/routes/vision.ts:138`
    - `apps/api/src/routes/chat-app-transport.ts` (:255, :310)
    - `apps/api/src/channel-ai.ts` (:776, :789, :824, :1182)
    - `packages/agent/src/memory/store.ts:183`
  - Internal callers (added Phase 2 surfacing):
    - `packages/agent/src/planner/index.ts:282`
    - `packages/agent/src/executor/index.ts:1508`
    - `packages/agent/src/sprint/planner.ts:129`
    - `packages/agent/src/tasks/escalate.ts:181`
- Deps: Phase 3 (telemetry schema frozen; shadow methodology proven)
- Context budget: ≤45% per PR; spread across sessions if needed
- Subagents: Explore per file for task-type + chain-composition; general-purpose for the edit
- Exit: every former `withFallback` call site goes through new router when flag on; old path still works when flag off.
- Status: pending

---

## Phase 5 — Telemetry + dashboards

- Scope: Finalize `model.routed` event in `packages/agent/src/telemetry/` (or wherever telemetry primitives live — Phase 2 audit confirms); wire downstream join to `inference.completed` for quality feedback; build dashboards for: cascade-position histogram, alternatives-considered breakdown, per-`(workspace, provider, task)` p95, manifest-staleness report.
- Deps: Phase 4
- Context budget: ≤45%
- Subagents: Explore for current telemetry sink + dashboard infra (Helm? PostHog? OTel?)
- Exit: dashboards live; weekly manifest-staleness report cron scheduled (mitigates pre-mortem #1). **Settings-page badge UI surface wired for `provider.auth_failed` event** (operator decision C3 — not just dashboard event).
- Status: pending

---

## Phase 6 — Flag flip + bake

- Scope: Flip `PLEXO_TASK_ROUTER` default to **on**. Monitor for 1 week. Rollback plan: flip flag off + redeploy.
- Deps: Phase 5
- Context budget: ≤45%
- Subagents: none
- Exit: 7-day clean window — no regressions in p95 latency, error rate, or operator-filed routing complaints. **Cooldown-equivalence verified**: router-v2 cooldowns cover all failure modes that legacy `providerBreaker` map covered (bypass is by design but must be at-parity before flip).
- Status: pending

⚠ **One-way door:** rollback after flip requires either flag-flip-and-redeploy (cheap) or, if Phase 7 has started, code revert (expensive). Phase 7 MUST NOT start until Phase 6 bake completes.
⚠ **Operator sign-off gate** — explicit "approved to flip" before this phase begins; explicit "approved to proceed to Phase 7" after bake.

---

## Phase 7 — Deprecate `withFallback` + remove single-model policy + clean dead code

- Scope:
  - Remove `withFallback` (`packages/agent/src/providers/registry.ts:812`) and `isRetryableProviderError` (collapsed into route-executor's error-class branching).
  - Remove single-model gate at `router.ts:305-333` (`handleByok` bypass logic).
  - Remove `DEFAULT_MODEL_ROUTING` map (registry.ts:270) if fully superseded by manifest.
  - Remove dead chain-resolver code path (`chain-resolver.ts`) IF the manifest fully replaces it; otherwise keep + document.
  - Remove `apps/api/src/lib/seed-routing-chains.ts` if `routing_chains` table is no longer read.
  - Audit `provider.fallback_engaged` (registry.ts:849) + `inference.chat.fallback` (inference.ts:286) telemetry — supersede with `model.routed` or keep for back-compat dashboards.
  - Remove `PLEXO_TASK_ROUTER` flag (becomes permanent path).
- Deps: Phase 6 clean bake
- Context budget: ≤45%
- Subagents: Explore for any remaining `withFallback` references; general-purpose for the deletes.
- Exit: `withFallback` symbol no longer exists in repo; CI green; one final commit removes the flag.
- Status: pending

---

## Risks & decisions log

| # | Risk / decision | Owner | Status |
|---|---|---|---|
| C1 | Manifest shape (flat vs rich) | Operator | Pending |
| C2 | Telemetry granularity | Operator | Pending |
| C3 | Auth-failure surface | Operator | Pending |
| Q1 | "Best" definition (hybrid recommended) | Operator | Pending |
| Q2 | Low-quality-only workspaces | Operator | Pending |
| PM1 | Manifest drift after model release | Mitigated by `last_validated_at` + quarterly review (Phase 5) | Planned |
| PM2 | Stats poisoning across workspaces | Mitigated by schema-enforced workspace scoping + Phase 2 unit test | Planned |
| PM3 | Operator override vs measured decision | Mitigated by honoring `preferenceOrder[0]` on first try + telemetry surfacing tension | Planned |

---

## Status

- **Current phase:** Phase 2 (done, awaiting operator review of PR)
- **Next action:** operator reviews PR `feat/router-v2-phase-2-core`; merges as DRAFT-then-mergeable; Phase 3 starts with `inference.ts:274` shadow mode.
