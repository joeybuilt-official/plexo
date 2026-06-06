# ADR 0001 — Graphiti lane isolation, model routing, and 'general' manifest gap

Date: 2026-06-05
Status: Proposed (awaiting operator gate)
Branch: feat/round4-optimize (off main eae1eb4)

## Context

Round-4 targets cost/latency. Audit findings (feat/round4-optimize):

1. **Graphiti episode-extraction is the dominant background AI load and rides the uncapped interactive lane.** The graphiti sidecar POSTs to `/api/inference/ws/<wsid>/v1/chat/completions` several times per `add_episode` (entity/relationship extraction + embeddings); each episode takes 4.7–13.8s on ws 69d1's deepseek-v4-flash. `inference.ts:240` classifies schema-mode requests as `taskType:'extraction'`. Per the Phase L operator decision, `extraction` is in the **interactive** lane (unbounded) — so graphiti's high-volume extraction (~60 routes/240s observed) is **not** concurrency-capped and competes with interactive planning, partially defeating lane isolation (Phase L).

2. **The inference proxy accepts no caller-supplied taskType/lane override** (`inference.ts`), but it is service-key authed and already sees/synthesizes `X-App-Id` (e.g. `graphiti-sidecar`). A trusted-caller hook point exists.

3. **Graphiti's model is not independently configurable** — it follows the workspace's router-v2 cascade (deepseek default). There is no `GRAPHITI_*` model override in the repo.

4. **`taskType:'general'` has no manifest entry.** It is handled gracefully by the #11 noManifestMatch fallback to `available[0]` (the `chosen:null, fallbackEngaged:false` telemetry is emitted *before* the fallback executes — not an error). Cost: every 'general' call skips scoring and always uses the primary provider.

## Decision (proposed)

- **D1 — Graphiti lane:** add a **per-caller lane override** to the inference proxy: when the trusted caller identifies as a background app (`X-App-Id` in a background allowlist, e.g. `graphiti-sidecar`), classify the call into the **background** lane regardless of schema mode. This caps graphiti via `PLEXO_BG_AI_MAX_CONCURRENT` without reversing the Phase L decision that genuine interactive `extraction` stays interactive. Env-gated, default-on only when lane isolation is on.
- **D2 — Graphiti model (separate phase, gated):** optionally route background-classified inference-proxy calls to a fast provider (cerebras/groq) instead of deepseek, cutting per-episode latency ~5–10x and offloading deepseek. Quality risk on structured extraction → keep behind its own flag, default off; enable + observe.
- **D3 — 'general' manifest entry:** add `general` to the manifest (additive) so it scores across providers instead of always-fallback. Low risk.

## Conflicts surfaced (expert panel) — for operator

- **Performance vs Maintainability:** per-caller lane override (D1) adds app-id branching in the hot inference path. Alternative — globally reclassify `extraction`→background — is simpler but reverses the explicit Phase L operator decision and would cap *all* extraction including any genuinely-interactive use. Panel recommends D1 (surgical) to preserve Phase L intent.
- **Cost/Performance vs Extraction-quality:** D2's faster/cheaper model may degrade graphiti entity extraction vs deepseek. Panel recommends D2 as its own flagged phase, default off, A/B-observed — not bundled with D1.
- **Data-freshness vs Interactive-protection:** capping graphiti to the background lane (max 2) can slow graph episode throughput during backlog drains, so the graph lags postgres further. Acceptable because postgres is authoritative and graph reads/writes are already decoupled (Phase H/O). No user-facing impact.

## Pre-mortem (3 failure modes + fallback)

1. **Lane override mis-classifies a genuinely-interactive caller as background → user-facing latency.** Fallback: allowlist is explicit (only known background app-ids); env flag `PLEXO_INFERENCE_BG_APPS` (default `graphiti-sidecar`); set empty to disable instantly without redeploy.
2. **D2 fast model degrades graph quality silently.** Fallback: D2 behind its own flag (default off); revert = flip flag + recreate (no rebuild). Keep deepseek as the cascade fallback.
3. **'general' manifest entry picks a wrong/expensive provider.** Fallback: mirror an existing cheap background tier (e.g. summarization priors); additive, revert by removing the entry. Manifest-shape tests guard structure.

## Verification (budget-aware; ws 69d1 over $50)

- Prefer log-based: confirm graphiti inference calls log `lane:background` / are gated by the semaphore; confirm interactive planning still routes to cerebras with no added queueing.
- Unit tests for laneFor-with-override + manifest 'general' entry.
- No driven build tasks unless strictly necessary; reuse the existing background graphiti traffic as the live load.
