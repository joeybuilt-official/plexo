# Plexo Round-4 — Cost/Latency Optimization — Master Plan

Date: 2026-06-05. Branch `feat/round4-optimize` off `main` (eae1eb4). Prod = NAS `joeybuilt` compose at `/data/appdata/appdata`; deploy = overlay→build→recreate, hostname-gated. Budget-aware: ws 69d1 ~$57 over $50 ceiling → prefer log-based + unit verification, minimize driven tasks. See `adr/0001-graphiti-lane-and-routing.md`.

## Goal
Stop background graphiti episode-extraction from competing with interactive task planning, and close minor routing gaps — without reversing Phase L or risking graph-extraction quality.

## Phases

## Phase 1 — Per-caller background lane override (inference proxy)
- Scope: in `apps/api/src/routes/inference.ts`, when the trusted caller's `X-App-Id` is in a background-app allowlist (env `PLEXO_INFERENCE_BG_APPS`, default `graphiti-sidecar`), route the call through the **background** lane regardless of schema mode. Mechanism: pass an explicit `lane`/`laneOverride` into `routeAndCall` (extend `withLane` to accept an override) OR map such callers to a background taskType for lane purposes only (keep the actual taskType for manifest scoring). Flag-gated by existing `PLEXO_AI_LANE_ISOLATION`; empty allowlist = today's behavior.
- Deps: none. Subagents: general-purpose for the edit + tests.
- Exit: unit tests prove background-app calls acquire the background semaphore while normal interactive `extraction` does not; agent+api tsc clean; lane-limiter suite green.
- Status: pending

## Phase 2 — Deploy Phase 1 + live lane verification
- Scope: overlay changed files (byte-identical-base check), build plexo-api, recreate, set `PLEXO_INFERENCE_BG_APPS=graphiti-sidecar` in compose+.env. Verify via logs: graphiti inference calls gated by background semaphore; interactive planning still routes cerebras with no added queueing; 0 graph timeouts retained.
- Deps: Phase 1. Subagents: none.
- Exit: live logs show graphiti calls in background lane; planning unaffected.
- Status: pending

## Phase 3 — 'general' manifest entry
- Scope: add a `general` taskType entry to `packages/agent/src/providers/router-v2/manifest.ts` (mirror a cheap background tier so it scores instead of always-fallback via #11). Update manifest-shape tests.
- Deps: none (independent of 1–2; can bundle into Phase 2's build). Subagents: none.
- Exit: router-v2 suite green; a `general` route logs a scored `chosen` (not noManifestMatch fallback).
- Status: pending

## Phase 4 — Executor setup latency re-measure (log-based, no budget)
- Scope: from existing prod logs, quantify current executor/tool-set setup time now that fylo-bridge ships + lane-iso + Phase 1 are live (compare to the ~5min Phase K/L observation). Identify the dominant remaining contributor (background AI churn vs plugin load vs graphiti). Record findings; spin a follow-up phase only if a concrete lever appears.
- Deps: Phase 2 (so lane override is live during measurement). Subagents: Explore for log analysis.
- Exit: a measured setup-time figure + named dominant contributor recorded in plan.md.
- Status: pending

## Phase 5 — Background-lane observability gauge — DONE (commit 2db8205, prod 34470b7e68db)
Counters (bgAcquired/bgQueued/bgMaxQueueDepth/bgOverrides) in withLane → getLaneStats() → router-stats snapshot cron (30m). Live-read: `ssh <server> 'docker logs --since 1900s plexo-api | grep "background-lane counters"'`. First tick ≤30m after the 01:56Z recreate.

## D2 — Graphiti fast-model routing (DEFERRED, operator opt-in — EXECUTABLE SPEC)
Goal: route background-app (graphiti) inference calls to a fast provider (cerebras/groq gpt-oss-120b) to cut per-episode 5–14s → ~1–2s + offload deepseek. Quality risk on structured entity extraction → flag default-off, A/B via the Phase 5 gauge + graphiti add_episode timings.
Why a new hook (not existing knobs): `settings.modelOverrides[taskType]` (selector.ts:95) is workspace-wide per taskType → would hit ALL 'extraction' incl. interactive. Manifest bump (#1-style) likewise global. Need per-CALL scoping to the bg-app caller.
Executable steps (next session):
1. `RouteAndCallInput.modelIdOverride?: string` (router-v2/index.ts) + thread into `SelectInput` → `selectModel` (selector.ts:145). When set and a provider in `availableProviders` resolves to that model id, force-pick it (bypass scoring; keep cascade fallback to normal scoring on call failure). Keep telemetry `chosen` + a `forcedModel:true` flag.
2. inference.ts: when `backgroundLaneOverride(req)` is background AND env `PLEXO_INFERENCE_BG_MODEL` set (e.g. `cerebras/gpt-oss-120b` or bare model id), pass `modelIdOverride` into routeAndCall. Empty/unset = today (no D2).
3. Tests: forced model picked when provider available; falls back to normal selection when forced model's provider absent or call fails; flag-off = no override.
4. Deploy flag default-OFF; enable by setting `PLEXO_INFERENCE_BG_MODEL` + recreate; observe gauge + graphiti add_episode latency for ~1h; revert = unset env.
Entry points: selector.ts:86 resolveModelId / :145 selectModel / :153 candidate loop; index.ts:129 RouteAndCallInput / :142 routeAndCall; inference.ts backgroundLaneOverride + :304 routeAndCall call.

## One-way doors / operator gates
- D1 lane mechanism (per-caller override vs global reclassify) — operator decision (ADR 0001 conflict #1). Recommended: per-caller override.
- D2 fast-model — separate opt-in (ADR 0001 conflict #2).
- Every prod deploy hostname-gated + announced; push to public origin within the standing Round-4 OK.

## Status (2026-06-05)
- Phase 1 — DONE, committed 7249487 (lane override + tests; router-v2 79/79, inference 28/28; agent+api tsc clean).
- Phase 2 — DONE, deployed prod image 8fc6581a5b7e (rollback 8e13631a5ef6); override active (BG_APPS=graphiti-sidecar, LANE_ISO=1, BG_MAX=2); 0 errors; graphiti functioning. Compose backup docker-compose.yml.pre-bgapps.bak. Prod-source snapshot 0a8312f.
- Phase 3 — DESCOPED (general already graceful via #11; not a router TaskType).
- Phase 4 — INCONCLUSIVE; recreate flushed logs, no in-window interactive task. Re-measure under natural load. Positives: fylo-bridge absent, deepseek p95 ~6.5s.
- D2 (graphiti fast-model) — DEFERRED, operator opt-in.

## Decisions log
- 2026-06-05 — Plan created. Per-caller lane override chosen over global extraction-reclassify to preserve the Phase L decision. D2 model-swap deferred to its own flag. 'general' manifest entry is additive cleanup.
- 2026-06-05 — Phase 3 descoped: 'general' is a DB/category type, not a router TaskType; #11 noManifestMatch already falls back gracefully. Adding it = invasive TaskType-union change for no functional gain.
- 2026-06-05 — Phase 1+2 shipped + merged to main. Runtime lane-cap not observable (Phase L deferred metrics) → flagged a minimal lane-gauge as a future follow-up. Phase 4 latency re-measure needs steady-state under natural interactive load.
