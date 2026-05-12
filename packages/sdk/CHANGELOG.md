# @joeybuilt/plexo-sdk — changelog

## 1.2.0 — 2026-05-12

### Added — Synchronous gmessages tool-invoke (Levio↔gmessages bridge)

- `client.tools.gmessages.send({ workspaceId, threadId?, phoneE164?, text })`
  → `{ messageId, deliveryStatus }`. Synchronous HTTP path into the libgm
  sidecar; blocks until the sidecar accepts or rejects the request. Errors
  bubble (NOT swallowed) so the calling app's chat UI can surface them.
- `client.tools.gmessages.listThreads({ workspaceId, phoneE164?, limit? })`
  → `GmessagesThread[]`. Folds `conversations` rows into per-thread summaries
  ordered most-recent first.
- New types: `GmessagesSendOptions`, `GmessagesSendResult`,
  `GmessagesListThreadsOptions`, `GmessagesThread`,
  `GmessagesThreadParticipant`, `GmessagesLastMessage`.

### Known gaps in 1.2.0 (server-side, not SDK)

- `participants: []` is always empty — gmessages schema has no per-thread
  participant table and libgm does not surface a participant list via the
  sidecar. The field ships for forward-compatibility.
- `unreadCount: 0` is always zero — `conversations` does not track read
  state for gmessages.
- `send({ phoneE164, ... })` without `threadId` returns HTTP 501
  `PHONE_LOOKUP_NOT_IMPLEMENTED` — supply `threadId` from `listThreads()`.
  Phone→thread resolution requires a sidecar endpoint that does not exist
  yet. The SDK accepts the param so future enrichment is non-breaking.

### Compatibility

- 1.1.0 surface unchanged. New methods land on the SDK's new
  `tools.gmessages` namespace; nothing existing renames or moves.
- Internal: requires Plexo Core ≥ the commit that adds
  `POST /api/v1/connections/gmessages/send` +
  `GET /api/v1/connections/gmessages/threads` (this PR). Older Plexo cores
  will return 404 on the new routes; unlike addEpisode/searchFacts the new
  methods do NOT swallow errors (a chat send failure must surface to the
  user), so callers must wrap with try/catch.

## 1.1.0 — 2026-05-11

### Fixed — Webpack/edge bundling at Next.js consumers

- tsup `onSuccess` hook now restores the `node:` prefix on Node built-in
  imports in dist. esbuild strips `node:` from external imports during ESM
  emit (even with `platform:'node'`), which broke Next.js webpack + edge
  runtime bundling at consumer sites — webpack couldn't resolve bare `crypto`.
- Source-level imports already used `node:crypto`; the fix preserves that
  contract end-to-end through the build pipeline.
- No public-API change. Pure build artifact correctness.

### Added — Graph methods (Phase 8 of `graphiti-migration/plan.md`)

- `PlexoClient.addEpisode(workspaceId, opts)` — append a knowledge-graph episode
  for the workspace; the Graphiti sidecar runs entity + relationship extraction
  and returns the episode UUID + extracted-fact count.
- `PlexoClient.searchFacts(workspaceId, query, limit?)` — hybrid search across
  the workspace's facts; returns the matching `EntityEdge` set with bi-temporal
  metadata (valid_at / invalid_at).
- New types: `AddEpisodeOptions`, `AddEpisodeResult`, `FactSearchResult`.

### Deferred to 1.2.0

- `PlexoClient.searchNodes(...)` — graphiti-core 0.29 has no `search_nodes`
  method; richer `search_()` (returning SearchResults w/ nodes) needs a sidecar
  surface change to expose. Lands when the surface is stable.
- `PlexoClient.getCommunity(...)` — graphiti-core 0.29 only has
  `build_communities` (a builder, not a getter). A community accessor needs
  custom Cypher/Kuzu queries on the sidecar.

### Compatibility

- 1.0.0 surface unchanged. Existing `storeMemory` / `searchMemory` continue to
  hit the workspace's `memory_entries` table via the SDK's existing routes; the
  new graph methods are additive and call new `/api/v1/graph/*` routes against
  the same Plexo Core instance.
- Internal: requires Plexo Core ≥ the commit that adds `apps/api/src/routes/graph.ts`
  + `services/graphiti-sidecar/main.py` Phase 3c wiring + `MEMORY_WRITE_BACKEND`
  flag plumbing. Older Plexo cores will return 404 on `/api/v1/graph/episodes`;
  the SDK methods return null/[] in that case (best-effort semantics preserved).
