# @joeybuilt/plexo-sdk — CHANGELOG

## 1.1.0 — 2026-05-09

### Added
- `graphMutate(workspaceId, concepts, source, memoryEntryId?)` — upsert concept nodes + link membership.
- `graphExpand(workspaceId, stimulus, opts?)` — recursive CTE BFS expansion.
- `graphMeta(workspaceId)` — per-workspace counts + last update.
- `graphExtractTrigger(workspaceId, sourceLogId?)` — heartbeat for the extraction worker.
- New types: `ConceptInput`, `GraphMutateResult`, `ExpandedNode`, `GraphExpandResult`, `GraphMeta`.

### Notes
- A 1.1.0 candidate that exposed SCL endpoints (`sclMutate`, `sclExpand`, `sclRecordMeta`, `sclExtractTrigger`) was prepared but **never published**; it was reverted before publish. The SCL surface has been retired in favor of the concept-graph layer (ADR 0009). Plexo Core no longer routes `/api/v1/scl/*`.

## 1.0.0 — 2026-05-09

- Universal client rolled out across app-starter / levio / fonto / nexalog / pushd. ADR 0006.
