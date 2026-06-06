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

## D2 — Graphiti fast-model routing (DEFERRED, own gated phase)
Optional: route background-classified inference-proxy calls to a fast provider (cerebras/groq) to cut per-episode latency ~5–10x + offload deepseek. Quality risk on structured extraction → separate flag (default off), A/B observed. NOT in scope unless operator opts in after Phase 2.

## One-way doors / operator gates
- D1 lane mechanism (per-caller override vs global reclassify) — operator decision (ADR 0001 conflict #1). Recommended: per-caller override.
- D2 fast-model — separate opt-in (ADR 0001 conflict #2).
- Every prod deploy hostname-gated + announced; push to public origin within the standing Round-4 OK.

## Decisions log
- 2026-06-05 — Plan created. Per-caller lane override chosen over global extraction-reclassify to preserve the Phase L decision. D2 model-swap deferred to its own flag. 'general' manifest entry is additive cleanup.
