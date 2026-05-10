# @joeybuilt/plexo-sdk — changelog

## 1.1.0 — 2026-05-09 (unreleased; pending operator publish)

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
