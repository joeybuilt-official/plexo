# Plexo Post-Rebuild Dead Code & Stale Reference Audit
Generated: 2026-05-01 — Phase 0 of PLEXO-MEMORY-CLEANUP

Tags: **DELETE** | **MIGRATE** | **STALE-PROMPT** | **NEEDS-UPDATE** | **VERIFY** | **FLAG**

---

## Section 1 — SCL Remnants (`cleanup-audit-scl-remnants.txt`)

### Live code — actionable

| File | Line(s) | Pattern | Tag | Action |
|------|---------|---------|-----|--------|
| `packages/agent/src/scl/` | entire dir | compressor.ts, expander.ts, extractor.ts, types.ts, inference-log.ts, index.ts, classifier.ts, embeddings-cluster.ts, pii-scrub.ts + tests | **DELETE** | Delete entire `packages/agent/src/scl/` directory and remove `@plexo/scl-core` deps |
| `apps/api/src/agent-loop.ts` | 1032–1042 | `reflectResult.track === 'scl'`, `reflectResult.sclStats.attractorsRefined/Created/ghostsArchived/driftWarnings`, `attractorLabel: 'aggregate'` | **DELETE** | Remove entire `if (reflectResult.track === 'scl' && reflectResult.sclStats)` block |
| `packages/agent/src/behavior/reflect.ts` | 54–56 | `sclStats?: { attractorsRefined, attractorsCreated }` on `ReflectResult` | **DELETE** | Remove `sclStats` field from `ReflectResult` type |
| `apps/api/src/analytics/events.ts` | 556–575 | `attractorsRefined`, `attractorsCreated`, `attractorLabel` event fields | **DELETE** | Remove these fields from the analytics event schema |
| `packages/agent/src/domain-mastery/index.ts` | 65–87 | `attractorIds: string[]` param in credit hash function | **NEEDS-UPDATE** | Remove `attractorIds` from hash params and call sites; update comment at :65 |
| `packages/agent/src/behavior/types.ts` | 66 | JSDoc mentions "attractor IDs in prompt" in context_hash description | **NEEDS-UPDATE** | Update comment to remove attractor ID reference |
| `packages/db/src/schema.ts` | 634, 657 | JSDoc comments mentioning "attractor IDs" in work_ledger/domain mastery columns | **NEEDS-UPDATE** | Remove attractor ID references from column comments |
| `apps/api/src/lib/embeddings-reembed.ts` | 253–254 | Comment: "refresh attractor centroids on next read. Full attractor recomputation is Phase 3b." | **NEEDS-UPDATE** | Delete stale comment block |
| `apps/web/src/app/page.tsx` | 357 | `{ title: 'Drift Detection', desc: 'Protected attractor mutations...' }` marketing feature card | **DELETE** | Remove this feature card from the landing page |
| `apps/web/src/app/app/settings/intelligence/layout.tsx` | 24 | Comment referencing `/app/settings/intelligence/scl/attractors` route | **DELETE** | Remove stale route comment |
| `tests/integration/workspace-isolation-security.test.ts` | 44 | `fetchAsA('/api/v1/workspaces/${WS_B}/scl/attractors')` — calls deleted route | **DELETE** | Remove or replace this assertion with a still-live route |

### False positives — skip

| File | Pattern | Reason |
|------|---------|--------|
| `apps/embeddings/src/engine.ts:128` | `// L2 normalize` | Linear algebra term, not SCL level |
| `docs/security/extension-security-model.md:69-70` | `L1 Pre-install review`, `L2 Per-invocation approval` | Security trust levels, not SCL |
| `packages/agent/src/memory/cluster.ts:790-795` | `priorL0`, `priorL1`, `priorL2`, `perLevel[0]` | Cluster hierarchy levels in new memory system — legitimate |

### Docs/historical — low priority

| File | Tag | Note |
|------|-----|------|
| `docs/memory.md` | **NEEDS-UPDATE** | Entire SCL section (compression pipeline, MindsetObject, attractors) describes the old system |
| `docs/plexo-memory-audit.md` | **FLAG** | Historical audit doc; references deleted files. Archive or keep as-is. |
| `ops/coreaudit/`, `ops/stabilization/`, `ops/harnesseval/` | **FLAG** | Historical analysis; no action required |
| `brand-rework/1-PERSONALITY.md:115,118` | **FLAG** | Brand doc references SCL concept graphs as differentiator — needs marketing update |
| `brand-rework/0-AUDIT.md:55` | **FLAG** | Lists SCL settings pages that no longer exist |

### Already deleted — confirmed clean

- `apps/api/src/routes/scl-admin.ts` — GONE ✓
- `apps/api/src/routes/scl.ts` — GONE ✓
- `apps/api/src/routes/training-data.ts` — `workspace_mindsets` lines GONE ✓
- `apps/api/src/agent-loop.ts` — `expandForConversation`, `recallPriorConversation`, `compressToMindsetObject` GONE ✓
- `apps/api/src/routes/chat.ts`, `telegram.ts`, `discord.ts`, `slack.ts` — `recallPriorConversation` GONE ✓

---

## Section 2 — Stale Prompts (`cleanup-audit-stale-prompts.txt`)

| File | Line | Pattern | Tag | Action |
|------|------|---------|-----|--------|
| `packages/agent/src/memory/store.ts` | 166 | `SHORTHAND_SYSTEM_PROMPT = 'You are a memory compression engine.'` | **STALE-PROMPT** | Replace: `'Use the provided memory facts directly — do not summarize or compress them.'` |
| `apps/api/src/routes/training-data.ts` | 290 | `{ role: 'system', content: 'You are a memory compression engine for Plexo.' }` | **STALE-PROMPT** | Replace with atomic-fact-aligned system prompt |
| `docs/memory.md` | 3, 25–28, 37, 61–103 | Describes SCL compression pipeline, MindsetObject, concept attractors | **NEEDS-UPDATE** | Rewrite to describe atomic fact memory system |
| `packages/agent/src/scl/inference-log.ts` | 20, 24 | Reads `workspaces.settings` for SCL enabled/disabled flag | **DELETE** | Deleted with `packages/agent/src/scl/` (Section 1) |

### False positives

| File | Pattern | Reason |
|------|---------|--------|
| `apps/api/src/routes/__tests__/intelligence-dashboard.test.ts:130` | `scl: { enabled: true, driftThreshold: 0.2 }` in settings fixture | Settings shape — verify if `scl` key in workspace settings is still meaningful; if dead → **NEEDS-UPDATE** |

---

## Section 3 — RSI Loop + Health Monitor (`cleanup-audit-rsi.txt`)

### RSI — live tables, verify not reading deleted schema

| File | Line(s) | Pattern | Tag | Action |
|------|---------|---------|-----|--------|
| `apps/api/src/agent-loop.ts` | 1013–1049 | `reflectAndPromote()` call + reads `reflectResult.sclStats.*` | **NEEDS-UPDATE** | Remove `sclStats` branch (covered in Section 1); verify `reflectAndPromote` now writes atomic facts via `write.ts` |
| `packages/agent/src/executor/index.ts` | 2349–2361 | `reflectAndPromote()` call | **NEEDS-UPDATE** | Verify it no longer reads or sets `sclStats` fields |
| `packages/agent/src/behavior/reflect.ts` | 72 | `reflectAndPromote` implementation | **VERIFY** | Confirm output writes atomic facts to `memory_entries`; not SCL format |
| `apps/api/src/routes/rsi.ts` | 5, 23–111 | `rsiProposals`, `rsiTestResults` DB reads/writes | **VERIFY** | Tables are live in schema — verify no column references workspace_mindsets or SCL fields |
| `packages/agent/src/introspection/rsi-monitor.ts` | 1, 85–109 | `rsiProposals` reads/inserts | **VERIFY** | Legitimate RSI anomaly detection — confirm no SCL column reads |
| `packages/agent/src/introspection/shadow-test.ts` | 4, 24–116 | `rsiProposals`, `rsiTestResults` | **VERIFY** | Same — confirm no SCL dependencies |
| `apps/api/src/cron.ts` | 10 | `import { runRSIMonitor }` | **VERIFY** | Legitimate cron job — confirm rsi-monitor no longer reads workspace_mindsets |
| `scripts/simulate-rsi.ts` | 21, 79 | `rsiProposals` delete/select | **VERIFY** | Dev script — legitimate |
| `tests/unit/introspection/rsi.test.ts` | 2–77 | `rsiProposals` in test mocks | **VERIFY** | Confirm mock shape matches current schema |

### buildIntrospectionSnapshot — verify clean

| File | Line(s) | Tag | Action |
|------|---------|-----|--------|
| `packages/agent/src/introspection/index.ts` | 180 | **VERIFY** | Grep confirmed: `workspace_mindsets` NO LONGER queried ✓. Confirm it now reads `queryMemory` for self-model facts |
| `apps/api/src/routes/chat.ts` | 736–737 | **VERIFY** | Calls `buildIntrospectionSnapshot` — clean if index.ts is clean |
| `apps/api/src/channel-ai.ts` | 584–586 | **VERIFY** | Same |
| `apps/api/src/routes/introspect.ts` | 23, 75, 85 | **VERIFY** | Same |
| `packages/agent/src/executor/index.ts` | 652–653 | **VERIFY** | Same |

### Health monitor — current system, no stale keys

| File | Line(s) | Pattern | Tag | Note |
|------|---------|---------|-----|------|
| `apps/api/src/health-monitor.ts` | 17–18 | `VALKEY_KEY_STATE = 'health-monitor:state'`, `VALKEY_KEY_TIMELINE = 'health-monitor:timeline'` | **VERIFY** | Current system. Phase 3 will audit for missing memory system monitors |
| `apps/api/src/index.ts` | 447 | `startHealthMonitor()` call | **VERIFY** | Legitimate startup call |

---

## Section 4 — Channel Adapter Coverage (`cleanup-audit-bridge-coverage.txt`)

### Confirmed wired

| File | Lines | Status |
|------|-------|--------|
| `apps/api/src/routes/chat.ts` | 1016, 1095 | ✓ Calls `extractConversationMemory` from conversation-bridge |
| `apps/api/src/routes/telegram.ts` | 1049, 1056 | ✓ Calls `extractConversationMemory`; has non-fatal catch |
| `packages/agent/src/memory/conversation-bridge.ts` | 198 | ✓ Dispatches `extractTurn` → `extract-worker.js` |

### Gap — needs investigation

| File | Tag | Issue |
|------|-----|-------|
| `apps/api/src/channel-ai.ts` | **FLAG** | NOT found in bridge coverage grep. Verify whether `channel-ai.ts` calls `conversation-bridge` after each turn. If not, Phase 4 must wire it in. |

### Stale comment

| File | Lines | Tag | Action |
|------|-------|-----|--------|
| `packages/agent/src/tests/conversation-bridge.fixture.test.ts` | 6–7 | **NEEDS-UPDATE** | Comment says "SCL concept extractor" — update to "atomic fact extractor" |

---

## Section 5 — Valkey Key Patterns (`cleanup-audit-valkey.txt`)

### Stale SCL key patterns in code

**None found.** No `mindset:*`, `golden-record:*`, `scl:*`, or `workspace_mindsets:*` key patterns exist in any Valkey set/get/del call.

### Current key inventory (verified live)

| Key Pattern | Location | TTL | Purpose |
|-------------|----------|-----|---------|
| `health-monitor:state` | `apps/api/src/health-monitor.ts:17` | unbounded | Health monitor state snapshot |
| `health-monitor:timeline` | `apps/api/src/health-monitor.ts:18` | capped at MAX_TIMELINE_ENTRIES | Health event ring buffer |
| `owd:{taskId}:ack` | `apps/api/src/sse-emitter.ts:114` | 300s | SSE task acknowledgment |
| `zeroclaw:parallel:slots` | `apps/api/src/parallel-executor.ts:191` | unbounded | Parallel executor slot tracking |
| `prefKey(workspaceId)` | `packages/agent/src/memory/store.ts:539,638,648,656` | PREF_TTL | Workspace preference cache |
| `searchKey(workspaceId, query, type)` | `packages/agent/src/memory/store.ts:359,459` | SEARCH_TTL | Memory search result cache |
| Rate limit key | `apps/api/src/middleware/workspace-rate-limit.ts:68,81` | 60s | Per-workspace rate limit |
| SSO nonce key | `apps/api/src/sso/token.ts:142,151` | USED_KEY_TTL_SECONDS | SSO token replay prevention |
| Analytics config key | `apps/api/src/analytics/config.ts:144,154` | 30d | Analytics config cache |
| Introspect cache key | `apps/api/src/routes/introspect.ts:49,67,80` | TTL_SECONDS | buildIntrospectionSnapshot cache |
| Version cache key | `apps/api/src/routes/system.ts:69` | — | System version cache |
| Embedding cache key | `packages/agent/src/memory/embeddings.ts:51,158` | — | Per-text embedding cache |

**No stale keys need flushing.** Valkey flush script (Phase 5) can be scoped to scan patterns only as a safety net; no live code is writing stale keys.

---

## Summary by Phase

| Phase | Blocking items | Quick wins |
|-------|---------------|------------|
| **Phase 2 (Stale Prompts)** | `store.ts:166` SHORTHAND_SYSTEM_PROMPT; `training-data.ts:290` system prompt | Stale comment in `conversation-bridge.fixture.test.ts:6-7` |
| **Phase 2 (SCL package)** | `packages/agent/src/scl/` — entire package DELETE | `reflect.ts:54-56` sclStats type field |
| **Phase 2 (agent-loop)** | `agent-loop.ts:1032-1042` sclStats block DELETE | `analytics/events.ts:556-575` attractor fields |
| **Phase 3 (RSI)** | Verify `reflectAndPromote` writes atomic facts, not SCL | Verify `buildIntrospectionSnapshot` reads `queryMemory` |
| **Phase 3 (health monitor)** | Add missing memory system monitors (extraction rate, embedding lag, cache hit, decay) | — |
| **Phase 4 (channels)** | Verify `channel-ai.ts` calls conversation-bridge | — |
| **Phase 5 (Valkey)** | No stale keys in code — write flush script as safety net only | Document key schema (data above) |
