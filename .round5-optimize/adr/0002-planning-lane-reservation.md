# ADR 0002 — Reserve interactive-planning capacity from background AI churn (WS C)

Date: 2026-06-06
Status: Proposed (awaiting operator gate)
Project: Plexo Round-5 optimization

## Context

`.followup-phased/plan.md` documented (and Round-4 partly addressed) that high-volume background AI churn starves interactive task planning: "0 tasks complete globally in 10 min" while a flood of summarization+extraction model.routed events saturate the worker.

Round-4 fixes covered graphiti specifically (per-caller background-lane override, D1) and validated the background cap engages (lane gauge: bgQueued>0). But the audit shows the **general** starvation source remains:

- `lane-limiter.ts:26-34`: only `summarization`, `judging`, `logAnalysis` map to the BACKGROUND lane. **`extraction`, `planning`, `codeGeneration`, `conversation` are INTERACTIVE and unbounded.**
- The memory pipeline calls `routeAndCall` with `taskType='extraction'` at high volume (`extract-worker.ts`, etc.) — **interactive, uncapped** — so it competes head-to-head with `planning` in the same unbounded lane.
- Phase L deliberately kept genuine interactive `extraction` in the interactive lane (so we cannot just reclassify `extraction`→background globally — that was already rejected).
- There is **no reserved capacity** for `planning`; it has zero gating.

So even with graphiti capped, the memory `extract-worker`'s interactive-lane extraction can crowd out planning.

## Decision (proposed — two candidate mechanisms, operator picks)

**Option A — Reserved planning slots.** Add a small reserved concurrency budget for `planning` (and other high-stakes interactive tiers) that background/secondary work cannot consume. Implement as a third "reserved" lane or a planning-priority semaphore. Pro: directly guarantees planner availability. Con: more lane machinery; tuning the reserve.

**Option B — Cap interactive *background-origin* extraction.** Route the memory `extract-worker`'s extraction through the existing background lane (it is background-origin, like graphiti) via a `laneOverride` at the call site — WITHOUT touching genuine user-facing interactive extraction. Pro: reuses the Round-4 D1 mechanism; minimal new code. Con: must correctly distinguish background-origin from user-facing extraction call sites.

Recommend **Option B** (surgical, reuses proven D1 lane-override) as the first move; escalate to Option A only if planning still starves under load. Both are flag-gated by the existing `PLEXO_AI_LANE_ISOLATION`.

⚠ One-way-ish: changes runtime concurrency semantics for memory extraction. Reversible via the lane-isolation flag, but behavior change is observable. Operator gate.

## Conflicts surfaced (expert panel)

- **AI-systems (Ada) vs Data-freshness (Dara):** capping memory extraction to the background lane slows memory/graph ingestion during backlog drains, so memory lags further behind. Ada prioritizes interactive planner availability; Dara worries about stale recall. Resolution lean: acceptable — postgres is authoritative, graph/memory reads are decoupled (same rationale as Round-4 ADR-0001 #3). Operator confirms.
- **Performance (Pat) vs Maintainability (Mort):** Option A's reserved lane adds a third concurrency primitive + tuning knob; Mort prefers Option B's reuse of existing override. Pat notes Option B depends on correctly tagging call sites and can miss a path. Recommend B first, with a test asserting extract-worker extraction acquires the background semaphore.

## Pre-mortem (3 failure modes + fallback)

1. **Mis-tagging a user-facing extraction call site as background → user-perceived latency.** Fallback: tag ONLY the known background workers (extract-worker, reflect, self-improvement); leave the inference-proxy/interactive paths untouched; unit-test which lane each acquires; flag-revert instantly.
2. **Background cap (BG_MAX=2) too low → memory ingestion backlog grows unbounded.** Fallback: cap is env-tunable (`PLEXO_BG_AI_MAX_CONCURRENT`); monitor the lane gauge bgQueued/bgMaxQueueDepth; raise if backlog persists.
3. **Reserve (Option A) starves background entirely under sustained interactive load.** Fallback: reserve is a floor not a cap — background still uses idle interactive capacity; size the reserve small (1–2 slots).
