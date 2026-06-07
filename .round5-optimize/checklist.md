# Plexo Round-5 — checklist

## Phase 1 — Reliability + log hygiene (WS D)
- [x] node_events pruning added to runDataRetention() (cron.ts); NODE_EVENTS_RETENTION_DAYS default 7; prod read-only check: 58227 total / 2237 prunable@7d / 0 pending
- [x] unhandledRejection logging normalized to Error (index.ts:852, mirror cc-ingest.ts)
- [x] fylo-bridge: CLOSED as non-issue — enabled in prod (ws 69d1), loader degrades gracefully (plugins/bridge.ts:196 warn+skip), 0 module errors in current image; audit "dead plugin" was stale-image artifact. No change (deleting would remove a live extension).
- [x] api tsc green; committed (Round-5 P1)
- [x] deployed (img 8339f3fd) + verified healthy; retention runs on daily 3am cron

## Phase 2 — HTTP backpressure + payload safety (WS F1) ⚠ — CODE DONE
- [x] Inventory: generalLimiter is app-wide (2000/15min/IP) so inference/events WERE behind a coarse IP limit that would throttle a busy single-IP graphiti container
- [x] serviceLimiter (app-id-keyed, PLEXO_SERVICE_RATE_MAX default 1200/min, 0=off) added; generalLimiter now skips /api/inference + /api/v1/events; serviceLimiter mounted on both
- [x] embeddings batch cap (PLEXO_EMBEDDINGS_MAX_BATCH default 256, 0=off) → 413 BATCH_TOO_LARGE before provider fan-out (inference.ts)
- [x] test: oversized batch → 413 (inference 33/33); api tsc green
- [x] committed (0a8dc1f) + deployed (img 994250e4) + verified healthy; 0 spurious 429 (quiet window)

## Phase 3 — discovery DONE; operator gate CLEARED
- [x] entry points recorded in plan.md (schema:318, migration 0128, dispatch site, telemetry.ts, ab-variants welchsTTest, graphiti task-less → needs proxy)
- [x] OPERATOR GATE CLEARED 2026-06-06: migration APPROVED as scoped; proxy = SHADOW RE-EXTRACTION (not cheap proxy)

## Phase 2 — HTTP backpressure + payload safety (WS F1) ⚠
- [ ] Explore: inventory current per-router rate-limit application (index.ts)
- [ ] rate limit /api/inference (chat+embeddings) + /api/v1/events; per-app/workspace limits sized from observed graphiti/Fonto rates
- [ ] embeddings batch-size cap (reject oversized input[] before provider; inference.ts:152)
- [ ] tests (429 past threshold + legit-rate passes); tsc green; deployed; 0 spurious 429 for graphiti/Fonto

## Phase 3 — Routing→quality linkage + A/B scorecard (WS B) ⚠ migration — CODE DONE
- [x] migration 0128: nullable routed_provider/routed_model on tasks + routing_events + shadow_extraction_results tables (+ journal entry idx 127)
- [x] write routing choice at dispatch: executor patches tasks.routed_provider/model (resolvedMeta) at the judge update (executor/index.ts:2632)
- [x] persist model.routed to routing_events (telemetry.ts emitRoutedEvent → fire-and-forget INSERT; taskId threaded via RouteAndCallInput)
- [x] add routing_events + shadow_extraction_results to runDataRetention() (ROUTING_EVENTS_RETENTION_DAYS default 30)
- [x] scorecard: eval/routing-scorecard.ts — routingScorecard() (Welch via exported ab-variants.welchsTTest, qualityScore by routed_model) + shadowExtractionScorecard()
- [x] graphiti SHADOW re-extraction: routes/shadow-extraction.ts — sampled (PLEXO_SHADOW_EXTRACTION_RATE default 0=OFF), background-app + schema-mode only, agreement + field-count → shadow_extraction_results
- [x] tests (4 scorecard) + tsc green (db/agent/api); inference 33/33, router-v2 87/87, executor+judge 36, cron 30 — no regressions
- [x] deployed + verified: prod img 5042e794, healthy; cols routed_provider/model + routing_events + shadow_extraction_results present; 0 errors
- [x] INCIDENT (resolved): this deploy does NOT auto-run drizzle migrations on startup. New schema cols are referenced by the queue batch-claim select, so recreating plexo-api BEFORE applying 0128 broke the queue ("column routed_provider does not exist" every 2s for ~1-2min). Fix: applied 0128 SQL directly via `docker exec postgres psql -d plexo` (additive IF NOT EXISTS). FUTURE migration phases (6, 8) MUST apply the SQL to prod BEFORE/at recreate, not rely on startup.

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
