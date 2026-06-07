# Plexo Round-5 — checklist

## Phase 1 — Reliability + log hygiene (WS D)
- [ ] node_events pruning added to runDataRetention() (cron.ts:161-175); retention window chosen
- [ ] unhandledRejection/uncaughtException logging normalized to Error (index.ts:852-854, mirror cc-ingest.ts:27-29)
- [ ] fylo-bridge dead plugin removed (or plexo.json:10 entry fixed) — confirmed 0 workspaces enable it
- [ ] tests + agent/api tsc green; deployed; verified (bounded node_events, real rejection stack, no fylo-bridge module error)

## Phase 2 — HTTP backpressure + payload safety (WS F1) ⚠
- [ ] Explore: inventory current per-router rate-limit application (index.ts)
- [ ] rate limit /api/inference (chat+embeddings) + /api/v1/events; per-app/workspace limits sized from observed graphiti/Fonto rates
- [ ] embeddings batch-size cap (reject oversized input[] before provider; inference.ts:152)
- [ ] tests (429 past threshold + legit-rate passes); tsc green; deployed; 0 spurious 429 for graphiti/Fonto

## Phase 3 — Routing→quality linkage + A/B scorecard (WS B) ⚠ migration
- [ ] migration: nullable routed_provider/routed_model on tasks (operator OK)
- [ ] write routing choice at dispatch; persist model.routed to a table (replace console sink)
- [ ] add routing_events to runDataRetention()
- [ ] scorecard query (Welch t-test via ab-variants.ts) qualityScore by routed_model for extraction
- [ ] graphiti extraction-quality proxy chosen (parse-fail/entity-count first)
- [ ] tests + tsc green; migration clean; deployed

## Phase 4 — D2 flip A/B execution (WS B) ⚠ operator GO
- [ ] operator GO; set PLEXO_INFERENCE_BG_MODEL=cerebras/gpt-oss-120b + recreate
- [ ] observe gauge + scorecard ~1h+; record measured keep/revert decision

## Phase 5 — Planner-starvation: lane reservation (WS C) ⚠
- [ ] Explore: enumerate background-origin extraction call sites
- [ ] laneOverride=background on extract-worker/reflect/self-improvement extraction (Option B); flag-gated
- [ ] unit test: background-origin extraction acquires bg semaphore; interactive extraction does not
- [ ] deployed; lane gauge shows added bg traffic; planning unaffected

## Phase 6 — Per-app cost attribution + burn-rate alert (WS E) ⚠ migration
- [ ] migration: app_id (+task_type) on inference_logs (operator OK)
- [ ] record X-App-Id at log time; per-app monthly spend query
- [ ] burn-rate / pre-ceiling alert via ops-alert path
- [ ] tests + tsc green; deployed; attribution verified on real data

## Phase 7 — Chat per-token streaming + a11y/mobile (WS A + G-partial)
- [ ] stream generateText into intermediate progress events (executor/index.ts:1912)
- [ ] chat aria-live/focus mgmt + reduced-motion
- [ ] 390px composer/activity-panel ergonomics; Playwright shots at 390px
- [ ] deployed; 1-step task shows live streaming activity

## Phase 8 — Security depth: key-versioning + audit + X-App-Id (WS F2/F3) ⚠ one-way
- [ ] read-compat multi-key (enc:v2:<keyId> + legacy) — DEPLOY 1 (writes stay v1)
- [ ] verify both formats decrypt in prod; THEN flip writes to v2 — DEPLOY 2
- [ ] audit provider-credential mutations + super-admin actions
- [ ] X-App-Id integrity decision (sign vs document trust model)
- [ ] tests + tsc green

## Phase 9 — QA load/chaos + observability (WS G)
- [ ] inference-proxy load + cascade fault-injection tests
- [ ] chat SSE e2e (reconnect/cancel mid-stream)
- [ ] router_v2_stats dashboard + SLO/alerting on /metrics
- [ ] CI green; dashboard reads router_v2_stats; SLO breach alerts
