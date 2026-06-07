# ADR 0005 — Single-provider rule: low quality never hard-blocks

Date: 2026-06-07
Status: ACCEPTED — SHIPPED + VERIFIED (commit cb5a91a → prod img 73550e59)
Project: Plexo Round-5 (follow-on)

## Verification (prod, 2026-06-07)
On ws 69d1 (all-gpt-oss = "low quality"): every `model.routed` now shows `requireOperatorAction: false` + `degradation_reason: workspace_low_quality_only` with a chosen provider (e.g. ollama_cloud served when groq/cerebras were at 100% failure). No "Operator action required" hard-block observed. 87/87 router-v2 tests green.

## Context
Operator requirement: "Users should be able to use Plexo with a single provider connected." The router's selector (`selector.ts`) had a **Q2-hybrid block** (ADR-era C6 Q2): for high-stakes task types, if NO candidate met `LOW_QUALITY_THRESHOLD` (manifest priorScore ≥ 3), it returned `chosen: null, requireOperatorAction: true` → `RouterV2NoCandidateError`. A workspace whose only provider is "low quality" per the manifest (e.g. any single gpt-oss-120b provider) therefore **could not run high-stakes tasks at all** — a dead end that violates the single-provider requirement.

## Decision
Remove the Q2-hybrid hard block. Low manifest quality is **never** a hard block. A high-stakes task on below-bar providers **degrades-and-proceeds**: route to the best available candidate and surface the existing `degradationReason: 'workspace_low_quality_only'` (non-blocking UI signal) instead of `requireOperatorAction`. This reverses the C6 Q2 decision per the operator directive.

Genuine no-provider cases are unaffected (empty pool / no manifest match are handled by separate paths). `selectModel` now never returns `requireOperatorAction: true`.

## Consequence
- Single-provider (and all-low-quality) workspaces are fully functional for every task type.
- The UI still gets `degradationReason` to optionally show a "your provider may be limited for this task" note — informational, not blocking.
- Tests updated: the two equivalence tests that asserted the block now assert degrade-and-proceed (87/87 green).
