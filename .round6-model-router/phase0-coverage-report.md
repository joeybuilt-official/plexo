# Phase 0 — models_knowledge coverage report (prod)

Date: 2026-06-06. Source: prod `plexo` DB (plexo-postgres on the server), read-only.

## Connected providers in prod (`provider_instances`, enabled)
anthropic, cerebras, deepseek, groq, ollama, ollama_cloud (6).

## models_knowledge coverage (528 rows, 6 providers)
| provider | rows | zero-cost | ctx=128k (default) | strengths=[] |
|---|---|---|---|---|
| anthropic | 30 | 0 | 30 | 0 |
| deepseek | 4 | 0 | 4 | 0 |
| google | 124 | 16 | 124 | 19 |
| groq | 21 | 0 | 21 | 5 |
| openai | 177 | 14 | 177 | 54 |
| together-ai | 172 | 34 | 172 | 121 |

(`google`/`openai`/`together-ai` rows exist but those providers are NOT connected in prod — `models_knowledge` mirrors `ALLOWED_PROVIDERS` in `providers/knowledge.ts`, not what's connected.)

## Gaps (named)
1. **3 of 6 connected providers have ZERO knowledge rows: `cerebras`, `ollama`, `ollama_cloud`.**
   - `cerebras` IS manifested (priorScore 4 on planning/etc) but absent from `ALLOWED_PROVIDERS` → no cost/context/strengths.
   - `ollama` / `ollama_cloud` are local/managed-pool; Portkey sync has no pricing for them (expected). `ollama_cloud` is the manifest fallback class.
   - Impact: under candidate-source = (configured ∪ discovered) ∩ knowledge, these 3 yield empty knowledge intersection. `buildModelCandidate` degrades gracefully (caps from manifest+quirks; cost/ctx=0). The candidate set must still include the configured model (single-provider rule), so they remain routable — but with no cost data (cost-tiebreaker blind) and no strengths-derived caps (manifest caps only).
2. **`context_window` is hardcoded 128000 for EVERY row** (`syncModelKnowledge` never reads it from Portkey — it's a literal default). So long-context capability NEVER derives from knowledge; `deriveCapabilities` must rely on manifest `long-context-200k`/`long-context-1m` caps. Min-context numeric gating (Phase 1/3) cannot trust `contextWindow` from knowledge — treat 128000 as "unknown".
3. **zero-cost rows** (google 16, openai 14, together-ai 34) — not connected in prod, so no current impact, but the cost-tiebreaker objective would be blind on them if connected.
4. **sparse strengths[]** (together-ai 121/172, openai 54/177) — capability derivation from strengths is thin for these; again not connected in prod.

## Confirmations
- `router_v2_stats` is keyed `(workspace_id, provider, model, task_type)` → **per-model live stats confirmed available**.
- 6 manifest providers: openai, anthropic, google, deepseek, groq, ollama_cloud + cerebras appears in entries (e.g. planning). `cerebras` manifested but unknowledge'd — backfill candidate.

## Recommendations for later phases (not actioned in Phase 0)
- Phase 1 capability gate: treat `contextWindow===128000` (or 0) as "unknown" — do not min-context-gate it out.
- Consider adding `cerebras` to `ALLOWED_PROVIDERS` and fixing `syncModelKnowledge` to read real `context_window` (separate hygiene task, flag-independent). Not required for the shadow path.
