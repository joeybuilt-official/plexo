# Plexo Round-4 — checklist

## Phase 1 — Per-caller background lane override — DONE (commit 7249487)
- [x] Extend `withLane` (lane-limiter.ts) with optional `laneOverride`
- [x] RouteAndCallInput.laneOverride threaded; inference.ts reads `X-App-Id` vs `PLEXO_INFERENCE_BG_APPS` (default `graphiti-sidecar`, empty=disabled) → background lane
- [x] Actual taskType kept for manifest scoring; override = lane gating only
- [x] Unit tests: override forces/respects lanes + flag-off passthrough (router-v2 79/79); allowlist mapping (inference 28/28)
- [x] agent + api tsc clean

## Phase 2 — Deploy + live verify — DONE (prod image 8fc6581a5b7e, rollback 8e13631a5ef6)
- [x] Overlaid 3 runtime files (byte-identical-base verified), `PLEXO_INFERENCE_BG_APPS` added to compose (default graphiti-sidecar; backup docker-compose.yml.pre-bgapps.bak), built + recreated
- [x] Healthy; in-container env BG_APPS=graphiti-sidecar, LANE_ISO=1, BG_MAX=2 → override active
- [x] 0 fatal errors, inference path clean, graphiti still completing add_episode — safe + active
- [~] Runtime lane-cap NOT directly observable (Phase L deferred metrics); mechanism unit-proven. FOLLOW-UP candidate: minimal lane gauge/debug log

## Phase 3 — 'general' routing — DESCOPED (verified graceful, no change)
- [x] Traced: `general` is a DB/category type, NOT a router `TaskType` (registry.ts union = 9 types, no 'general'). When it reaches the router unmapped, the #11 noManifestMatch path falls back to `available[0]` (primary provider) — already graceful; the `chosen:null fallbackEngaged:false` log is pre-fallback telemetry, not an error.
- [x] Adding 'general' to the manifest would require expanding the `TaskType` union + DEFAULT_MODEL_ROUTING (invasive) for a path that already works → NOT worth it. No code change.

## Phase 4 — Executor setup latency re-measure — DONE (dominant contributor identified)
- [x] Confirmed positives: fylo-bridge activation failures ABSENT (Phase P holds); deepseek p95 ~6.5s (lighter load) vs ~10-13s earlier
- [x] 47-min live histogram (ws 69d1f1f1): top log msg by 2× = `AI settings loaded from provider_instances` 1408×/47min (~30/min), single ws, NO cache. Each = 2 DB queries + AES-GCM decrypt + info log (settings-from-instances.ts:55). 2nd uncached path: ai-cred chain-walk 560×/47min (agent-loop.ts:237-326).
- [x] DOMINANT CONTRIBUTOR = uncached per-call provider-config loads on inference hot path (inference.ts:254 + agent-loop.ts:238 + embeddings/memory/reflect). Not fylo-bridge, not graphiti churn (now lane-capped), not plugin load.
- [x] `POST /api/v1/ai/tasks failed` ×4 = all `Delay was aborted` (client abort/supersede, benign).
- [x] Lever recorded → Phase 6 (TTL settings cache), proposed/operator-gated.

## Phase 6 — Workspace AI-settings cache — PROPOSED (operator gate)
- [ ] Short-TTL (30–60s) in-memory cache keyed by workspaceId around loadSettingsFromInstances + ai-cred resolver; write-invalidate on provider-instance edits (instances.ts)
- [ ] Flag-gateable (TTL=0 = today); gate b/c caches decrypted keys + config-change propagation correctness
- [ ] Verify: load rate drops ~30/min → ~1-2/min; no stale-config after a provider edit

## Phase 5 — Background-lane observability gauge — DONE (commit 2db8205, prod image 34470b7e68db)
- [x] lane-limiter.ts: counters bgAcquired/bgQueued/bgMaxQueueDepth/bgOverrides + getLaneStats(); recorded in withLane bg branch; reset in test helper
- [x] cron.ts: getLaneStats() logged in runRouterStatsSnapshot (every 30m)
- [x] tests: counter accounting + flag-off no-op + copy-on-read (lane-limiter 15/15); agent+api tsc clean
- [x] Deployed + healthy + 0 errors. Prod-source snapshot de0c7f8.
- [x] LIVE READING (2026-06-05): `{bgAcquired:607,bgQueued:61,bgMaxQueueDepth:3,bgOverrides:535}`. bgOverrides>0 ⇒ graphiti on bg lane CONFIRMED; bgQueued>0 ⇒ cap engaging CONFIRMED. Round-4 hypothesis proven in prod.
- [x] BUG: snapshot INSERT crashed every 30m (Date bind → ERR_INVALID_ARG_TYPE); router_v2_stats 0 rows ever. Fixed cron.ts:209-210 with `.toISOString()`. api tsc clean.
- [ ] Deploy fix to the server plexo-api; verify next tick logs `Router stats snapshot: persisted` + router_v2_stats gains rows.

## Deferred
- [ ] D2 — graphiti fast-model routing (separate flag, operator opt-in). RECOMMENDATION: HOLD — lane cap already solves interactive-competition; Phase 6 is higher-value/lower-risk. Revisit only if graphiti backlog-drain latency becomes a felt problem.
