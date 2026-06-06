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

## Phase 4 — Executor setup latency re-measure — INCONCLUSIVE (needs scheduled re-measure)
- [x] Confirmed positives: fylo-bridge activation failures ABSENT (Phase P holds); deepseek p95 ~6.5s (lighter load) vs ~10-13s earlier
- [ ] BLOCKED: plexo-api recreate flushed in-container logs; no interactive task in-window post-deploy → cannot compute claim→first-planning-route delta without driving a task (budget). Re-measure under natural interactive load next session, OR check if logs persist to disk/remote.

## Phase 5 — Background-lane observability gauge — DONE (commit 2db8205, prod image 34470b7e68db)
- [x] lane-limiter.ts: counters bgAcquired/bgQueued/bgMaxQueueDepth/bgOverrides + getLaneStats(); recorded in withLane bg branch; reset in test helper
- [x] cron.ts: getLaneStats() logged in runRouterStatsSnapshot (every 30m)
- [x] tests: counter accounting + flag-off no-op + copy-on-read (lane-limiter 15/15); agent+api tsc clean
- [x] Deployed + healthy + 0 errors. Prod-source snapshot de0c7f8.
- [~] First live reading at next snapshot cron tick (≤30m): grep `ssh <server> 'docker logs --since 1900s plexo-api | grep "background-lane counters"'`. bgOverrides>0 confirms graphiti rides the bg lane; bgQueued>0 confirms the cap engages.

## Deferred
- [ ] D2 — graphiti fast-model routing (separate flag, operator opt-in after Phase 2)
- [ ] Phase 4 — re-measure setup latency under natural load (now aided by the Phase 5 gauge)
