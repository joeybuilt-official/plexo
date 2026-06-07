# Plexo Round-5 — Optimization Master Plan

Date: 2026-06-06. Project root `/workspace/plexo/.round5-optimize/`. Repo `/workspace/plexo` (public, joeybuilt). Prod = the server compose `/srv/plexo`; deploy = byte-identical-base overlay → `docker compose build plexo-api` → `up -d --no-deps`, hostname-gated + announced. main @ `7385aa0`, prod plexo-api img `bff2c018`.

Carries Round-4 discipline: unit tests + `tsc` green before deploy; log/DB-based verification (budget-aware, ws 69d1 over $50); push within standing OK; caveman artifacts; NO hardwired provider; operator is Android-only (390px primary).

## Goal
Close the highest-value gaps/bugs surfaced by the 25-sim expert panel — backpressure + reliability hygiene first, then unblock a measured D2 flip, then planner-starvation, cost attribution, chat polish, and security depth — each phase shippable, prod-verifiable, and reversible.

## Audit overrides (changed the request as written)
- **WS A (chat transparency) is ~90% shipped** (Phase K reply-stream `chat.ts:1495`, `LivePlanCard`, `AgentThinkingPanel` for single-agent, clarification→alternatives→requeue `agent-loop.ts:861`/`blocked-actions.tsx`). Only real gap = per-token streaming of a single long `generateText`. S22 (1-step plans) = by-design + mitigated; S25 (capability dead-end) = solved. → WS A demoted to one optional phase.
- **WS D fylo-bridge = dead orphaned plugin** (`extensions/core/fylo-bridge/plexo.json:10`, only referenced in `connections/bridge.ts:933`; never auto-installed; error only if DB-enabled). Redis ENOTFOUND = by-design (`redis-client.ts:45-79`), no action. node_events retention truly absent; unhandledRejection empty-`reason` confirmed (`index.ts:852-854`).
- **WS F has a HIGH + cheap finding**: `/api/inference` + `/api/v1/events` + `/api/v1/embeddings` have **zero HTTP rate limiting**; oversized embeddings batch can OOM; `X-App-Id` spoofable → bg-lane + D2 model. Pulled forward to Phase 2.
- **WS B**: routing choice lost after dispatch (`telemetry.ts:57-60` console-only; no `routed_model` on `tasks`). Reuse existing unused `ab-variants.ts` (Welch t-test/UCB) + `foundry/shadow.ts`. SCL eval (`eval/scl-eval.ts`) is retrieval-only.
- **WS C**: only `summarization/judging/logAnalysis` are background (`lane-limiter.ts:26-34`); memory `extract-worker` extraction runs interactive + unbounded = the real planner-starvation source. Phase L forbids global `extraction`→background reclassify → use per-call-site override (ADR 0002 Option B).

## OSS benchmark (non-trivial pieces only)
- **A/B / online eval** (Phase 3-4): patterns from Optimizely/GrowthBook (fixed-horizon vs sequential), Vowpal-Wabbit/contextual-bandit. First principle: don't roll new stats — the repo already has Welch t-test + UCB in `ab-variants.ts`; reuse it for routing arms. Deliberate deviation: no live bandit auto-switching of models (quality risk) — human-gated flip only.
- **LLM-output eval** (Phase 3): OpenAI Evals / promptfoo / Ragas. First principle: golden set + a cheap automatic metric + a model-judge for nuance. Deviation: budget-bound → start with a downstream cheap proxy (parse-fail rate, entity/edge counts) before model-judge shadow scoring.
- **Rate limiting** (Phase 2): the repo already uses `express-rate-limit` + a Redis sliding-window workspace limiter; just extend coverage. No new lib.
- **Envelope key versioning** (Phase 8): AWS KMS / Tink envelope pattern — key id in the ciphertext header, keyring on read. Deviation: keep local HMAC-derived per-workspace keys (no KMS dependency); add only a version tag + previous-key read support.

## Expert panel (roster)
Sasha (Security), Pat (Performance), Mort (Maintainability), Uma (UX), Maya (ML/eval), Ada (AI-systems/agents), Sre/"Rey" (Reliability/SRE), Felix (FinOps), Dara (Data/DB), Quinn (QA), Ally (A11y/mobile), Pam (PM). Conflicts captured in ADRs 0001-0003 and per-phase below; unresolved ones are operator gates.

---

## Phases

## Phase 1 — Reliability + log hygiene quick wins (WS D)
- Scope: (a) add processed-`node_events` pruning to `runDataRetention()` (`cron.ts:161-175`) — `DELETE WHERE processed=true AND created_at < NOW()-INTERVAL retention`; (b) normalize `unhandledRejection`/`uncaughtException` logging to an Error (`index.ts:852-854`, mirror `cc-ingest.ts:27-29`) so `reason:{}` becomes diagnosable; (c) remove the dead fylo-bridge plugin (or fix `plexo.json:10` entry) — confirm zero workspaces enable it first. No redis change (by-design).
- Deps: none. Subagents: none (≤3 files each, surgical).
- Exit: unit/tsc green; deploy; verify post-deploy: node_events row count bounded after a retention tick; a forced rejection logs a real stack; no fylo-bridge "Cannot find module" on tool-set build.
- Status: pending

## Phase 2 — HTTP backpressure + payload safety (WS F1) ⚠ behavior-affecting
- Scope: apply rate limiting to the uncovered high-cost routes — `/api/inference` (chat/completions + embeddings, `index.ts:506`) and `/api/v1/events` (`index.ts:408`); add an embeddings batch-size cap (reject `input[]` over N before hitting the provider, `inference.ts:152`). Service-key callers: use a generous per-app/workspace limit (not per-IP) so legit graphiti/Fonto traffic isn't throttled — size from observed rates (graphiti ~bgAcquired/min from the lane gauge).
- Deps: none. Subagents: Explore to inventory current per-router limiter application before editing.
- Exit: tests assert limited routes 429 past threshold + legit-rate traffic passes; tsc green; deploy; verify graphiti/Fonto traffic uninterrupted (lane gauge steady, 0 spurious 429 in logs).
- Status: pending

## Phase 3 — Routing→quality linkage + A/B scorecard (WS B enabler) ⚠ migration / operator gate
- Scope: ADR 0001. Add nullable `routed_provider`/`routed_model` to `tasks` (additive migration ⚠); write them at dispatch; replace console `model.routed` with a persisted sink (+ add it to Phase-1 retention); a read-only scorecard query reusing `ab-variants.ts` Welch t-test over `qualityScore` by `routed_model` for `extraction`; pick the cheap graphiti extraction-quality proxy.
- Deps: Phase 1 (retention for the new event table). Subagents: general-purpose for migration+wiring+tests.
- Exit: scorecard query returns per-model mean qualityScore + sample counts + t-stat; migration applied cleanly (no lock incident); tsc green; deployed.
- Status: pending

## Phase 4 — D2 flip A/B execution (WS B) ⚠ operator gate (extraction quality)
- Scope: with the Phase-3 scorecard live, flip `PLEXO_INFERENCE_BG_MODEL=cerebras/gpt-oss-120b` (env+recreate, no rebuild); observe gauge + scorecard ~1h+; decide keep/revert. Operator-gated GO.
- Deps: Phase 3. Subagents: none.
- Exit: a recorded measured decision (keep with quality delta within bar, or revert) — D2 is no longer a guess.
- Status: pending

## Phase 5 — Planner-starvation: lane reservation (WS C) ⚠ concurrency-semantics
- Scope: ADR 0002. Route background-origin memory extraction (extract-worker/reflect/self-improvement) through the background lane via per-call-site `laneOverride` (Option B), leaving user-facing interactive extraction untouched; flag-gated by `PLEXO_AI_LANE_ISOLATION`.
- Deps: none (independent; can interleave). Subagents: Explore to enumerate all background-origin extraction call sites first.
- Exit: unit test proves extract-worker extraction acquires the background semaphore while interactive extraction does not; deploy; lane gauge shows the added bg traffic; planning routes unaffected.
- Status: pending

## Phase 6 — Per-app cost attribution + burn-rate alert (WS E) ⚠ migration
- Scope: add `app_id` (+ ensure `task_type`) to `inference_logs` (additive migration ⚠); record `X-App-Id` at log time; attribution query (Fonto vs chat vs memory vs graphiti); a burn-rate / pre-ceiling alert via the existing ops-alert path. NOTE: depends on Phase-2/8 X-App-Id integrity for trustworthy attribution (spoof caveat documented).
- Deps: Phase 1 (pattern), ideally after Phase 8 for trustworthy app-id. Subagents: general-purpose.
- Exit: per-app monthly spend query works on real data; an alert fires below ceiling in a test; deployed.
- Status: pending

## Phase 7 — Chat per-token streaming + a11y/mobile polish (WS A + G-partial)
- Scope: stream `generateText` (`executor/index.ts:1912`) into intermediate progress events so a single long step shows live token/thought activity (the one remaining transparency gap); chat `aria-live`/focus management for streamed updates + reduced-motion; 390px composer/activity-panel ergonomics.
- Deps: none. Subagents: Explore for the web render path.
- Exit: a 1-step task shows live streaming activity (not just "Generating (model)"); a11y/mobile verified via Playwright shots at 390px (per UI-testing rule); deployed.
- Status: pending

## Phase 8 — Security depth: key-versioning + audit + X-App-Id (WS F2/F3) ⚠ ciphertext-format one-way door
- Scope: ADR 0003. Read-compat multi-key (`enc:v2:<keyId>...` + legacy) FIRST deploy; flip writes to v2 in a SECOND deploy after read-compat verified; audit provider-credential mutations + super-admin; decide X-App-Id integrity option (sign vs document trust model).
- Deps: none. Subagents: general-purpose. Two-deploy sequence is mandatory (pre-mortem #2).
- Exit: legacy + v2 ciphertext both decrypt in prod; provider-key change writes an `audit_log` row; tsc/tests green.
- Status: pending

## Phase 9 — QA load/chaos + observability dashboards (WS G)
- Scope: inference-proxy load + cascade fault-injection tests; chat SSE e2e (reconnect/cancel mid-stream); router_v2_stats dashboard (data now persists) + SLO/alerting on `/metrics`.
- Deps: Phases 2-3 (so limits + stats exist to test/visualize). Subagents: general-purpose for tests.
- Exit: load/chaos tests run green in CI; a dashboard reads router_v2_stats; an SLO breach alerts.
- Status: pending

## One-way doors / operator gates (summary)
- Phase 2 ⚠ behavior (rate limits on live service traffic) — verify legit traffic unthrottled.
- Phase 3 ⚠ `tasks` migration (additive) — operator OK before migrate.
- Phase 4 ⚠ D2 flip — operator GO (extraction quality).
- Phase 5 ⚠ concurrency semantics — operator OK (ADR 0002 option).
- Phase 6 ⚠ `inference_logs` migration.
- Phase 8 ⚠ ciphertext-format change — two-deploy, keyring must retain keys.

## Recommended order (deviates from kickoff)
Kickoff suggested B→A+D→C→F→E→G. Audit reshapes to: **1 (D quick wins) → 2 (F1 backpressure, HIGH+cheap) → 3 (B enabler) → 4 (D2 flip) → 5 (C starvation) → 6 (E cost) → 7 (A polish) → 8 (F depth) → 9 (G QA)**. Rationale: A is mostly shipped (demoted); F1 is high-severity + cheap (pulled forward); D quick wins are near-zero-risk noise/growth fixes; B must precede the D2 flip.

## Decisions log
- 2026-06-06 — Plan created from 25-sim/12-expert panel. 5 parallel read-only audits reshaped scope (overrides above). ADRs 0001 (routing→quality+A/B), 0002 (lane reservation), 0003 (key-versioning) written for the one-way doors.
