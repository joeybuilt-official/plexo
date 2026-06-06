# Plexo Round-4 — checklist

## Phase 1 — Per-caller background lane override
- [ ] Extend `withLane` (lane-limiter.ts) to accept an explicit lane override
- [ ] inference.ts: read `X-App-Id` against `PLEXO_INFERENCE_BG_APPS` allowlist (default `graphiti-sidecar`); pass background lane override into routeAndCall when matched
- [ ] Keep actual taskType for manifest scoring; override affects lane only
- [ ] Unit tests: background-app call acquires bg semaphore; normal interactive extraction does not; flag-off = passthrough
- [ ] agent + api tsc clean; lane-limiter + router-v2 suites green

## Phase 2 — Deploy + live verify
- [ ] Overlay changed files onto prod (byte-identical-base check each)
- [ ] Build plexo-api; set `PLEXO_INFERENCE_BG_APPS=graphiti-sidecar` in compose+.env; recreate
- [ ] Verify health + env in container
- [ ] Logs: graphiti inference calls in background lane; interactive planning still cerebras, no added queueing; 0 graph timeouts

## Phase 3 — 'general' routing — DESCOPED (verified graceful, no change)
- [x] Traced: `general` is a DB/category type, NOT a router `TaskType` (registry.ts union = 9 types, no 'general'). When it reaches the router unmapped, the #11 noManifestMatch path falls back to `available[0]` (primary provider) — already graceful; the `chosen:null fallbackEngaged:false` log is pre-fallback telemetry, not an error.
- [x] Adding 'general' to the manifest would require expanding the `TaskType` union + DEFAULT_MODEL_ROUTING (invasive) for a path that already works → NOT worth it. No code change.

## Phase 4 — Executor setup latency re-measure
- [ ] Explore agent: quantify current setup time from prod logs (vs ~5min K/L baseline)
- [ ] Name dominant remaining contributor; record in plan.md
- [ ] Spin follow-up phase only if a concrete lever appears

## Deferred
- [ ] D2 — graphiti fast-model routing (separate flag, operator opt-in after Phase 2)
