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

## Phase 4 — Executor setup latency re-measure (log-based, no budget) — DONE (finding recorded)
- Scope: from existing prod logs, quantify current executor/tool-set setup time now that fylo-bridge ships + lane-iso + Phase 1 are live (compare to the ~5min Phase K/L observation). Identify the dominant remaining contributor (background AI churn vs plugin load vs graphiti). Record findings; spin a follow-up phase only if a concrete lever appears.
- Deps: Phase 2 (so lane override is live during measurement). Subagents: Explore for log analysis.
- Exit: a measured setup-time figure + named dominant contributor recorded in plan.md.

### FINDING (2026-06-05, 47-min live window, ws 69d1f1f1)
Log-msg histogram top entry by 2×: **`AI settings loaded from provider_instances` = 1408 loads in 47min (~30/min, one every ~2s), ALL one workspace, NO cache.** Each `loadSettingsFromInstances` (settings-from-instances.ts:55) = **2 DB queries (provider_instances + workspaces) + per-row AES-256-GCM decrypt + an info log**. A second uncached config path compounds it: agent-loop ai-cred chain-walk = 560 loads/47min (`ai-cred: walking provider chain` / `settings loaded` / `API key found in DB`, agent-loop.ts:237-326).
- **Dominant remaining contributor = uncached per-call provider-config loads on the inference hot path** (callers: inference.ts:254 [every graphiti episode posts several], agent-loop.ts:238, embeddings/router.ts, memory bridge/extract, reflect). NOT fylo-bridge (absent, Phase P holds), NOT background AI churn directly (graphiti now lane-capped, Phase 1/5 proven), NOT plugin load.
- provider_instances for a workspace changes ~daily; reloading it ~30×/min with crypto is pure waste. **Concrete lever → Phase 6 (proposed).**
- Other log noise: 828× `Federation event type not handled — marking processed and dropping` (per local-node-event) + 12× `Stabilization alert raised` — separate observability noise, not setup latency; out of Round-4 scope (flag only).
- "Setup-time figure": no instrumented claim→first-route timer exists; 4× `POST /api/v1/ai/tasks failed` were all `Delay was aborted` (client abort/supersede, benign — not crashes).
- Status: DONE.

## Phase 6 — Workspace AI-settings cache — DONE + VERIFIED (prod image b3925c3f, 2026-06-05)
VERIFIED: provider-config load rate dropped ~30/min → **~2.0/min** (4 loads/120s = one per 30s TTL window) while bg traffic kept flowing (25 events/120s); 0 errors. ~15× reduction on the inference hot path. Rollback = `PLEXO_SETTINGS_CACHE_TTL_MS=0` + recreate (no rebuild) or recreate on prior image 2b9607dd.
Goal: collapse the ~1408+560 uncached per-call provider-config DB loads (ws 69d1, 47min) to ~1 per TTL window. Short-TTL in-memory cache keyed by workspaceId around `loadSettingsFromInstances` covers BOTH hot paths (the agent-loop ai-cred resolver calls loadSettingsFromInstances at agent-loop.ts:238, then only does in-memory work — no extra DB). Cuts 2 DB queries + per-row AES-GCM decrypt off the inference hot path on the vast majority of calls.
- Impl: settings-from-instances.ts — `SETTINGS_CACHE_TTL_MS` (env `PLEXO_SETTINGS_CACHE_TTL_MS`, default 30000, 0=disabled=today); Map<wsId,{value,expiresAt}>; existing body → `loadSettingsFromInstancesUncached`; `invalidateSettingsCache(wsId?)` exported. instances.ts CRUD (add/update/remove/reorder) call invalidate for prompt freshness on operator edits. Other rare writers (judgeModel jsonb_set, discovery capability refresh, embeddings model/dims) rely on ≤TTL eventual consistency (embeddings fields aren't surfaced into WorkspaceAISettings anyway).
- Tests: settings-from-instances.test.ts +2 (memoize within TTL = no 2nd DB load; invalidate(ws) reloads that ws only, other ws stays cached). 6/6 green; reflect 6/6 + extract 10/10 unaffected; agent+api tsc clean.
- Risk/gate (operator-approved): caches decrypted keys in memory (already transient; 30s TTL bounds exposure) + config edits propagate ≤30s (instant via invalidate on the instances.ts edit path). Flag-off = `PLEXO_SETTINGS_CACHE_TTL_MS=0` (no rebuild needed to disable, just recreate).
- Verify (pending deploy): `AI settings loaded from provider_instances` rate should drop ~30/min → ~1–2/min; no stale-config after a provider edit.

## Phase 5 — Background-lane observability gauge — DONE (commit 2db8205, prod 34470b7e68db)
Counters (bgAcquired/bgQueued/bgMaxQueueDepth/bgOverrides) in withLane → getLaneStats() → router-stats snapshot cron (30m). Live-read: `ssh <server> 'docker logs --since 1900s plexo-api | grep "background-lane counters"'`. First tick ≤30m after the 01:56Z recreate.

### LIVE READING (2026-06-05, ~35min uptime, cumulative since process start)
`{bgAcquired:607, bgQueued:61, bgMaxQueueDepth:3, bgOverrides:535}`
- **bgOverrides=535 (>0) ⇒ graphiti CONFIRMED riding the background lane.** Phase 1+2 mechanism validated live in prod (535/607 = 88% of bg-lane work is the graphiti per-caller override).
- **bgQueued=61, maxDepth=3 (>0) ⇒ the BG_MAX=2 cap IS engaging.** Graphiti is genuinely concurrency-capped (peak 3 calls waiting) — no longer competing unbounded with interactive planning. Interactive lane unbounded ∴ planning unaffected. Core Round-4 hypothesis proven.

### BUG FOUND + FIXED — router-stats snapshot persistence crash
runRouterStatsSnapshot (cron.ts:198-218) logged the gauge fine (line 190, before the write) but the INSERT crashed every 30m: `ERR_INVALID_ARG_TYPE: ... Received an instance of Date` (postgres-js Bind). Root cause: raw `sql\`(${snapshotAt})\`` interpolation in a VALUES tuple gives drizzle no column-type context → Date passed untyped to postgres-js. `router_v2_stats` had **0 rows ever** (persistence never worked since the Phase-4-stabilization feature shipped). Note line 34 `.set({lastRunAt:new Date()})` works b/c the query-builder knows the column type. Fix: `.toISOString()` on both Date binds (cooldown_end_at + snapshot_at) so Postgres casts text→timestamp. Pre-existing bug, surfaced by the Phase 5 gauge investigation; fixing it makes Phase 5's DB persistence (+ Phase 4 trend history) actually work.

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
- Phase 4 — DONE. Dominant contributor = uncached per-call provider-config DB loads (1408+560/47min, single ws) on inference hot path. Concrete lever → Phase 6 proposed.
- Phase 5 — LIVE-VERIFIED. Gauge confirms graphiti on bg lane (bgOverrides 535) + cap engaging (bgQueued 61, depth 3). Found+fixed snapshot-persistence Date crash (0 rows ever → fix deploy pending).
- Phase 6 — DONE + VERIFIED (prod b3925c3f): config-load rate ~30/min → ~2/min (~15× cut), 0 errors.
- D2 (graphiti fast-model) — DEFERRED, operator opt-in. Recommendation: HOLD. Lane cap already solves the interactive-competition problem (Phase 5 proven); D2 is a throughput/cost play with extraction-quality risk. Phase 6 (config-load churn) is the higher-value, lower-risk next lever. Enable D2 only if per-episode graphiti latency (4.7–13.8s deepseek) becomes a felt backlog-drain problem.

## Decisions log
- 2026-06-05 — Plan created. Per-caller lane override chosen over global extraction-reclassify to preserve the Phase L decision. D2 model-swap deferred to its own flag. 'general' manifest entry is additive cleanup.
- 2026-06-05 — Phase 3 descoped: 'general' is a DB/category type, not a router TaskType; #11 noManifestMatch already falls back gracefully. Adding it = invasive TaskType-union change for no functional gain.
- 2026-06-05 — Phase 1+2 shipped + merged to main. Runtime lane-cap not observable (Phase L deferred metrics) → flagged a minimal lane-gauge as a future follow-up. Phase 4 latency re-measure needs steady-state under natural interactive load.
- 2026-06-05 — Phase 5 live-verified: gauge proves graphiti rides bg lane (bgOverrides 535) and the BG_MAX=2 cap engages (bgQueued 61, depth 3). Core Round-4 hypothesis confirmed in prod.
- 2026-06-05 — Found+fixed pre-existing router-stats snapshot crash (Date bind → ERR_INVALID_ARG_TYPE; 0 rows ever). One-liner `.toISOString()` fix in cron.ts. Deploy pending.
- 2026-06-05 — Phase 4 complete: dominant contributor = uncached per-call provider-config loads (~30/min single ws, 2 DB queries + AES-GCM each). Proposed Phase 6 (TTL settings cache) as the lever. D2 recommendation: HOLD (lane cap already addresses the core problem; Phase 6 is higher-value/lower-risk).
