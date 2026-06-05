# ADR 0001 — Plexo Stabilization Strategy

Status: Proposed (awaiting operator approval)
Date: 2026-06-04

## Context
A single session surfaced a cluster of failures culminating in "build me a flappy bird game?" doing nothing useful and the UI showing a false "Request timed out". Four independent root causes were found (see plan.md Audit). The operator's governing constraint: Plexo must function on a minimum of one modest model and scale to twenty; resilience must not depend on provider diversity.

## Decision
Stabilize in leverage+dependency order — **correctness → timeout-UX → structured-output resilience → observability → end-to-end validation** — rather than continuing per-incident whack-a-mole. Each phase ships independently and is reversible via the prior container image.

Three cross-cutting principles govern the work:
1. **Fail toward execution, not toward chat.** The intent classifier defaults must favor doing the work (or asking the LLM classifier), never silently degrading a build request to conversation.
2. **Time-to-first-byte ≠ time-to-first-token.** Flush the HTTP/SSE shell immediately and heartbeat while working; attack real pre-stream latency in parallel. Never let an idle-but-working connection look like a failure.
3. **Coerce at the boundary; fail closed only on safety.** Structured output is best-effort: repair + lenient parse + defaults so modest models complete tasks — BUT safety-critical fields (`oneWayDoors` approval gating) default to the SAFE side (require approval) when absent/invalid. Resilience never widens what executes unapproved.

## Consequences
- Positive: the most user-visible break (build request → nothing) is fixed first; the system degrades honestly instead of timing out; the operator gains persisted provider/task visibility; behavior is correct with one model.
- Negative / risk: schema relaxation could mask genuine planning errors or, done carelessly, weaken the destructive-action gate — mitigated by safe-side defaults + a `schema_relaxed` telemetry counter (pre-mortem #1). Streaming changes risk chat-render regressions — mitigated by an env flag + e2e validation (pre-mortem #2). The deepest risk is model capability — mitigated by honest degradation, not silent failure (pre-mortem #3).

## Escalations carried to the operator (not resolved unilaterally)
1. Safety vs resilience on `oneWayDoors` relaxation (safe-side defaults).
2. Latency: fix the real serial pre-stream work vs only heartbeat-mask it (lean: both).
3. Intent classifier: patch heuristic vs always-LLM-classify (lean: heuristic for unambiguous, LLM for the rest).
4. Observability cost: batched snapshot cron vs per-call writes (lean: batched).
