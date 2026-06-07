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
- [x] INCIDENT (resolved): this deploy does NOT auto-run drizzle migrations on startup. New schema cols are referenced by the queue batch-claim select, so recreating plexo-api BEFORE applying 0128 broke the queue ("column routed_provider does not exist" every 2s for ~1-2min). Fix: applied 0128 SQL directly via `docker exec plexo-postgres psql -d plexo` (additive IF NOT EXISTS). FUTURE migration phases (6, 8) MUST apply the SQL to prod BEFORE/at recreate, not rely on startup.

## Phase 4 — D2 flip A/B execution (WS B) ⚠ operator GO — EVAL WINDOW LIVE
- [x] confirmed cerebras/gpt-oss-120b enabled on ws 69d1f1f1 (vs deepseek-v4-flash)
- [x] enabled shadow eval in prod: compose PLEXO_SHADOW_EXTRACTION_MODEL=cerebras/gpt-oss-120b + PLEXO_SHADOW_EXTRACTION_RATE=0.1, recreated (live img 5042e794, healthy, 0 errors)
- [ ] WAIT for shadow_extraction_results to accrue usable n (graphiti is low-volume ~1-2/day → slow); read shadowExtractionScorecard()
- [ ] operator GO + high agreement + spot-check → set PLEXO_INFERENCE_BG_MODEL=cerebras/gpt-oss-120b + recreate; observe ~1h+; record keep/revert

## Phase 5 — Planner-starvation: lane reservation (WS C) ⚠ — CLOSED (already implemented)
- [x] enumerated background-origin call sites: extract-worker/reflect/self-improvement/store ALL use taskType:'summarization' (already background lane); graphiti uses Round-4 D1 laneOverride. NO background-origin 'extraction' site exists — ADR 0002 premise was stale.
- [x] Option B requires no code (already satisfied by existing taskType classification)
- [x] flag PLEXO_AI_LANE_ISOLATION=1 ALREADY enabled in prod (BG_MAX=2) — starvation mitigation is live
- [x] no deploy needed; escalate to Option A (reserved planning slot) ONLY if planning starves under observed load (no current evidence)

## Phase 6 — Per-app cost attribution + burn-rate alert (WS E) ⚠ migration — PAUSED at operator decision
- [x] discovery: inference_logs already has task_type; written ONLY by agent-loop:1197; proxy (graphiti/Fonto) does NOT write it → per-app needs a NEW proxy-side write
- [x] discovery: getWorkspaceSpend() reads inference_logs + backs the cost-enforcement gate → adding proxy rows risks BLOCKING over-budget ws 69d1. ops-alert = batched buffer (ops-alerts.ts); alerted_80 set but never consumed.
- [x] OPERATOR DECISION: attribution-only (exclude app rows from enforcement query) — chosen 2026-06-06
- [x] migration 0129: app_id on inference_logs (additive); schema.ts appId
- [x] proxy fire-and-forget inference_logs write w/ app_id (captures served provider); loadAppSpend grouping by app_id (mirrors pricing); getWorkspaceSpend excludes app_id IS NOT NULL
- [x] burn-rate alert: budget stream in ops-alerts.ts + agent-loop 80% false→true crossing via prior-value CTE
- [x] tests (ops-alerts-budget 3, app-spend 2) + tsc green; cost-enforcement 9 + inference 33 unbroken; applied 0129 to prod BEFORE recreate; deployed img 555ecb8f healthy, 0 errors

## Phase 7 — Chat per-token streaming + a11y/mobile (WS A + G-partial) — CLOSED (largely already built)
- [x] reduced-motion: ALREADY done (globals.css:425 universal prefers-reduced-motion: reduce)
- [x] aria-live: ALREADY done (chat log page.tsx:1262 role=log; plan-card + thinking-panel)
- [x] mobile composer: ALREADY solid (44px targets, text-[16px] anti-zoom, hidden sm:flex)
- [x] per-token streaming: ALREADY exists for direct chat (chat.ts:922 streamText per-chunk SSE); executor emits 3s ticks + progressEvents
- [x] DECLINED executor generateText→streamText (tool-path hot-loop regression risk > marginal gain); documented
- [ ] (optional, next UI session) verify/polish agent-thinking/activity panels at 390px via authed Playwright; web rebuild if changed

## Phase 8 — Security depth: key-versioning + audit + X-App-Id (WS F2/F3) ⚠ one-way
- [ ] read-compat multi-key (enc:v2:<keyId> + legacy) — DEPLOY 1 (writes stay v1)
- [ ] verify both formats decrypt in prod; THEN flip writes to v2 — DEPLOY 2
- [ ] audit provider-credential mutations + super-admin actions
- [ ] X-App-Id integrity decision (sign vs document trust model)
- [ ] tests + tsc green

## Phase 9 — QA load/chaos + observability (WS G) — PARTIAL (SLO alerting + chaos shipped)
- [x] inference-proxy cascade fault-injection: chaos test (provider cascade exhaustion → clean 500) added to inference.test.ts (34/34)
- [x] SLO/alerting: evaluateSloBreaches() (pure, tested 9) + runRouterStatsSnapshot enqueues breaches → batched ops-alerts flush; env PLEXO_SLO_MIN_SUCCESS(0=off)/MIN_SAMPLES/MAX_P95_MS
- [ ] (next) router_v2_stats dashboard panel — extend apps/api/src/routes/intelligence-dashboard.ts (latest snapshot per key via router_v2_stats_key_idx)
- [ ] (next) chat SSE e2e reconnect/cancel mid-stream — GET /api/chat/reply-stream/:taskId
- [x] deployed (img pending — Phase 9 build/recreate in progress)
