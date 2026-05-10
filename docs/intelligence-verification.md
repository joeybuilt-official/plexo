# Intelligence Page — Verification Report

**Date:** 2026-04-08
**Status:** All principles verified. Ready for operator review.

---

## Principle Verification

### 1. One Ollama instance serves both LLM and embedding calls
**VERIFIED.** Docker Compose defines a single `ollama` service (image `ollama/ollama:0.6.2`) with init script pulling both `llama3.2:3b` (chat) and `snowflake-arctic-embed` (embedding). The OllamaAdapter at `packages/agent/src/ollama/adapter.ts` routes `/api/chat` and `/api/embed` to the same endpoint.

### 2. "Embedding" does not appear in the user interface
**VERIFIED.** Grep of all .tsx files in `settings/intelligence/` shows zero user-facing instances. All code references use the word in variable names (`embeddingModels`, `supportsEmbeddings`) but never render it to the screen. UI copy uses "Memory" and "Understanding" exclusively.

One instance fixed during verification: OpenAI description said "text-embedding models" — changed to "GPT models."

### 3. Capability discovery is automatic
**VERIFIED.** `OllamaAdapter.discoverCapabilities()` calls `/api/tags` and classifies models via the pattern-based classifier. `ensureFresh()` re-discovers every 15 minutes. The Intelligence page polls every 30 seconds. New models appear without user action.

### 4. Fallback chains are visible as priority order
**VERIFIED.** Both sections show arrow buttons for reordering. Description copy says "Order matters. Plexo tries the top one first."

### 5. Page is called Intelligence
**VERIFIED.** URL: `/app/settings/intelligence`. Nav label: "Intelligence". Page title: "Intelligence". Old `/app/settings/ai-providers` redirects to the new page.

### 6. Backward compatible
**VERIFIED.** Auto-migration in `migrate-to-instances.ts` reads existing vault/arbiter JSONB and creates ProviderInstance rows on first Intelligence page load. Existing routing (LLM and embedding) continues through the vault/arbiter system — the provider_instances table is read by the Intelligence page only. No existing behavior changes.

### 7. Zero-configuration default
**VERIFIED.** `seedManagedProvider()` creates "Plexo Built-in AI" at lowest priority for every workspace. The managed Ollama sidecar ships default chat and embedding models. `resolveEmbeddingAdapterAsync` falls through to managed Ollama when no user provider is configured.

---

## Paraphrase Cosine Similarity

Tested earlier this session against the live snowflake-arctic-embed model:

| Pair | Similarity |
|------|-----------|
| "The server is running out of memory" / "Memory usage on the server is critically high" | 0.9291 |
| "Deploy the new version to production" / "Push the latest release to the live environment" | 0.9114 |
| "Fix the authentication bug" / "Repair the login defect" | 0.9378 |

All well above the 0.7 threshold. Real semantic embeddings are flowing.

---

## Launch Readiness

- [x] All phase commits merged to main
- [x] 232 tests pass (134 agent + 82 scl-core + 14 mcp + 2 api)
- [x] Paraphrase similarity > 0.7 (0.91-0.94)
- [x] All 7 principles verified
- [x] Help documentation published (3 docs)
- [x] Operator workspace has working embeddings (61/61 entries, 100% coverage)
- [x] Old AI Providers URL redirects to Intelligence
- [ ] Managed Ollama sidecar deployed to production (requires operator action — compose update)
- [ ] Operator visual review of Intelligence page

---

## Rollback

If issues arise after deployment:

1. **Quick rollback:** Restore the old sidebar nav entry pointing to `/app/settings/ai-providers` by reverting the sidebar commit. The legacy page is preserved at `page.legacy.tsx`.
2. **Data safety:** The provider_instances table is additive — the existing vault/arbiter JSONB is untouched. Rolling back the UI doesn't affect routing or data.
3. **Managed Ollama:** Can be disabled by removing the `ollama` and `ollama-init` services from compose and unsetting `OLLAMA_INTERNAL_URL`.

---

## Follow-Up Work (Out of Scope)

1. **Router cutover:** The LLM and embedding routers still read from vault/arbiter JSONB. A future phase should migrate routing to read from provider_instances directly.
2. **Per-capability ordering:** Currently one `preferenceOrder` column. Spec suggested separate `chatPreferenceOrder` and `embeddingPreferenceOrder` for independent section reordering.
3. **First-visit explainer card:** Spec described a dismissible one-time card. Deferred — the redirect + new page layout is self-explanatory for existing users.
4. **Analytics events:** PostHog events for migration, first visit, provider adds. Can be added incrementally.
5. **Golden Record provider lineage:** Add `embeddingProvider`/`embeddingModel` fields to Golden Record metadata per Phase 0 findings.
