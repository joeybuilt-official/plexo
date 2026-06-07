# ADR 0001 — Routing-choice → outcome linkage + A/B scorecard (WS B enabler)

Date: 2026-06-06
Status: Proposed (awaiting operator gate)
Project: Plexo Round-5 optimization (`.round5-optimize/`)

## Context

Round-4 shipped the D2 graphiti fast-model hook (`PLEXO_INFERENCE_BG_MODEL`, default OFF). Flipping it on (route background graphiti `extraction` to cerebras instead of deepseek) carries an **extraction-quality risk** that cannot currently be measured:

- Router emits `model.routed` telemetry, but it is **console-only** (`router-v2/telemetry.ts:57-60`, "phase 5 placeholder").
- The routing choice is **lost after dispatch** — `tasks` has a post-hoc `qualityScore` (judge) but **no `routed_provider`/`routed_model`** column, so there is no join between "which model handled this" and "how good was the result."
- The existing eval harness (`packages/agent/src/eval/scl-eval.ts`) measures **retrieval** IR metrics only (recall@5/NDCG), not LLM-output quality.
- An A/B framework already exists but is **unused for routing**: `ab-variants.ts` (Welch t-test, UCB assignment, 20-sample threshold) and `foundry/shadow.ts` (semantic-agreement shadow scoring).

Without a routing→quality link, a D2 flip is a guess, and any silent quality regression on deepseek-vs-cerebras extraction is invisible.

## Decision (proposed)

1. **Persist the routing decision on the work unit.** Add `routed_provider TEXT` + `routed_model TEXT` to `tasks` (and/or to `inference_logs` for the inference-proxy path, which has no task row). ⚠ schema migration → operator gate.
2. **Real routing telemetry sink.** Replace the console placeholder with an append to a `routing_events` table (or fold into `inference_logs`), keyed so it can join to outcome (`qualityScore` for tasks; for proxy-only graphiti calls, capture a lightweight extraction-quality proxy — see #3).
3. **A/B scorecard.** Reuse `ab-variants.ts` Welch t-test to compare `AVG(qualityScore)` (and latency) grouped by `routed_model` for `taskType='extraction'`, gated at ≥100 samples/arm. Surface via a read-only query/endpoint (no new heavy UI required initially).
4. **Graphiti extraction quality proxy.** Graphiti `add_episode` calls are proxy-only (no task/judge). Options: (a) periodic shadow re-extraction with `foundry/shadow.ts` semantic-agreement vs deepseek baseline; (b) downstream signal (entity/edge counts, parse-failure rate already in `schema_relaxed` counters). Pick the cheapest that detects regression — decide in execution.

## Conflicts surfaced (expert panel) — for operator

- **ML (Maya) vs FinOps (Felix):** a rigorous A/B (shadow re-extraction on cerebras AND deepseek for the same episode) doubles graphiti inference cost during the eval window on an over-budget workspace. Felix wants a cheap downstream-signal proxy; Maya wants ground-truth shadow scoring. Recommend: cheap proxy first (parse-failure + entity-count deltas), escalate to bounded shadow only if the proxy is ambiguous.
- **Maintainability (Mort) vs Performance (Pat):** denormalizing `routed_model` onto `tasks` duplicates data already inferable from `inference_logs` joins. Pat argues the join is expensive at dashboard time; Mort argues a denormalized column drifts. Recommend: denormalize on `tasks` (write-once at dispatch, cheap) — outcome joins are the hot read.

## Pre-mortem (3 failure modes + fallback)

1. **Quality proxy doesn't actually track human-perceived quality → false green on D2.** Fallback: keep D2 default-OFF; require BOTH proxy-stable AND a manual spot-check sample before recommending flip; the flip stays env-reversible.
2. **Migration on `tasks` (hot table) locks/slows prod.** Fallback: additive nullable columns only (no backfill, no NOT NULL); add concurrently; columns are write-on-new-rows.
3. **routing_events table becomes the next node_events (unbounded growth).** Fallback: add it to `runDataRetention()` in the SAME phase (retention built in Phase 1).
