# ADR 0004 — Strict-mode structured-output schema compatibility (provider fallback fix)

Date: 2026-06-07
Status: ACCEPTED — implementing
Project: Plexo Round-5 (follow-on; surfaced by the 2026-06-07 browser sims)

## Context

Browser sims on ws 69d1 showed the chat erroring ("Something went wrong sending your message") when deepseek ran out of balance, and the operator correctly noted **other enabled providers (cerebras, groq, ollama_cloud) should have served the request**. Root-cause from prod logs:

- The router marks **cerebras + groq at "100% recent failure rate"** and degrades to ollama_cloud (`degradation_reason: workspace_low_quality_only`). They are not down — every structured-output call to them throws:
  `AI_APICallError: invalid JSON schema for response_format: 'Facts': /properties/facts/items/required: 'required' is required ... must include: domain`
- cerebras + groq are **OpenAI-compatible strict** structured-output providers: every property must appear in `required` (optional fields are illegal). The zod schemas use `.optional()`, so the generated JSON schema omits those keys from `required` → strict providers reject → `callModel` repair also fails → the provider is penalized to 100% failure → the router stops choosing it.
- Net: only ollama_cloud reliably works, the workspace looks "low quality", and when deepseek (primary) fails the cascade has only one healthy provider left — so a transient deepseek failure surfaces to the user instead of falling back cleanly.

This is the SAME class the repo already knows about: `sprint/planner.ts` carries the comment *"required by OpenAI strict mode (no optional fields)"* and was authored all-required. Several other structured-output schemas were not.

## Expert panel

- **Rey (Reliability):** This is the highest-leverage fix — it returns 3 of 4 providers to the healthy pool, so a single provider's billing/rate-limit blip no longer degrades the whole workspace. Keep the existing `callModel` repair/fallback as the safety net.
- **Ada (AI-systems):** The OpenAI-strict pattern for a genuinely-optional field is **required + nullable** (`type: ["T","null"]`), not omitted. zod `.nullable()` (NOT `.optional()`) produces exactly that and stays in `required`. Models honoring the schema emit the field (null when absent).
- **Maya (ML/eval):** No quality impact — null for an absent optional is equivalent to omission for every downstream consumer (all already do `x ?? null`/`if (x)`).
- **Mort (Maintainability):** Prefer fixing schemas at the source to match the repo's existing all-required convention over a risky centralized JSON-schema transform on the hot path. Lower blast radius; the repair path already centralizes the safety net.
- **Pat (Performance) / Felix (FinOps):** Fewer rejected calls = fewer wasted cascade hops = lower latency + cost. Endorse.

## Decision

Bring structured-output (callModel `schema`) schemas into strict compliance by replacing bare `.optional()` with `.nullable()` on genuinely-optional fields (required, null allowed) — matching the repo's existing planner convention. No centralized JSON-schema rewrite (rejected: blast radius across all schemas/providers; the per-schema fix + existing repair safety net is sufficient and lower-risk).

Fixes (bare `.optional()` → `.nullable()`):
- `memory/extract-worker.ts` `FactSchema.domain` — the one firing every conversation turn (highest impact).
- `memory/write.ts` `ResolutionSchema.rationale`.
- `planner/index.ts` `PhaseSchema.description`.
(`ExecutionPlanShape.phases` is `.optional().default([])` — has a default; handled separately if it proves to reject, lower priority.)

## Out of scope / operator-owned
- **deepseek "Insufficient Balance"** is an account-billing issue — top up deepseek or change the workspace primary provider. Not a code fix.
- **groq/cerebras rate-limits** ("Too Many Requests") are provider-side throughput; the fix lets the router USE them when healthy, but won't raise their limits.
- The graphiti-sidecar (Python) sends its own extraction schemas — if it has the same `required` issue, that's fixed in the sidecar repo, not here.

## Pre-mortem
1. **A non-strict model omits a now-`.nullable()`-required field → zod parse fails.** Fallback: the existing `callModel` repair (generateText + parse) + fallbackChain catches it; models generally honor required json-schema fields (the planner already relies on this). Reversible by reverting the schema.
2. **Consumer type drift (`string|undefined` → `string|null`).** Caught by `tsc`; consumers already null-coalesce.
