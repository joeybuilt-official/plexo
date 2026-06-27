# Workspace Memory and SCL

Plexo maintains workspace memory in two systems: a postgres-backed episodic memory store (`memory_entries`, pgvector) and SCL (Structured Context Language), a structural compression system that builds a navigable concept map from task history.

## Postgres memory pipeline

As of 2026-06-27, workspace memory writes and reads land exclusively on `memory_entries` (postgres + pgvector HNSW). The earlier Graphiti memory mirror was retired in the same change — see `CHANGELOG.md` and `MIGRATING.md` for the operator checklist.

Historical ADRs (memory pipeline retired 2026-06-27):
- [ADR 0010 — Graphiti adoption](../adr/0010-graphiti-adoption.md)
- [ADR 0011 — Python sidecar](../adr/0011-graphiti-python-sidecar.md)
- [ADR 0013 — Cutover execution](../adr/0013-graphiti-cutover-execution.md)
- [ADR 0014 — Post-cutover cleanup re-split](../adr/0014-post-cutover-cleanup-resplit.md)

Live decision: [ADR 0044 — Canonical recall vector store](../adr/0044-canonical-recall-vector-store.md) (postgres pgvector is the canonical recall store).

### Writes

All writes flow through `packages/agent/src/memory/write-backend.ts`. The `WriteBackend` type is the literal `'postgres'`; `getWriteBackend()` is a constant. The `MEMORY_WRITE_BACKEND` env var is no longer honored — leaving it set is harmless.

Writes insert into `memory_entries` (workspace-scoped, embedded via Gateway 384-d ONNX, pgvector column `embedding vector(384)` with HNSW index).

### Reads

Reads flow through `packages/agent/src/memory/read-backend.ts` and resolve via the postgres HNSW knn query in `packages/agent/src/memory/store.ts` (`searchMemory`). The `MEMORY_READ_BACKEND` env var is no longer honored.

### Bridge (non-memory consumers retained)

`packages/graphiti-bridge` is retained — eight non-memory call sites still use the bridge (workspace permission mirror, conversation cypher, planner cypher waves, ops scripts, the architecture-boundary regex, the `docker/Dockerfile.api` bridge stages, and the integration test). All of these silently no-op when `PLEXO_GRAPHITI_SIDECAR_URL` / `PLEXO_SERVICE_KEY` are unset, so operators can decommission the sidecar without touching code. See:

- `apps/api/src/lib/permission-graph.ts` (ADR 0022 — workspace permission graph)
- `apps/api/src/lib/graph-sidecar.ts` (conversation cypher)
- `packages/agent/src/sprint/cypher-waves.ts` (ADR 0020 — task-dag cypher)

These are out of scope for the memory pipeline; they are listed here only so future readers don't mistake the retained bridge for live memory wiring.

## SCL: Structured Context Language

SCL compresses workspace task history into a fixed-size generative structure called the MindsetObject. Unlike episodic memory that stores individual facts and their relations, the MindsetObject represents the workspace's accumulated patterns as a navigable concept space. Implementation lives at `packages/agent/src/scl/`.

### How it works

1. **Extraction** — After each task, inference logs are analyzed for tool usage patterns, task types, and quality scores
2. **Classification** — Each log is classified into a domain region using lightweight keyword matching (no LLM calls)
3. **Compression** — Domain regions are aggregated into the MindsetObject with concept attractors and transformation rules
4. **Expansion** — At task start, the MindsetObject is expanded into relevant context: suggested tools, domain knowledge, and patterns from similar past work

The entire pipeline is structural analysis. No LLM is used for compression or classification. Memory cost is zero tokens; no hallucination risk in the memory layer.

### The MindsetObject

```typescript
{
  version: "scl/0.2",
  workspaceId: "...",
  regions: MindsetRegion[],
  attractors: ConceptAttractor[],
  transformations: TransformationRule[],
  confidence: number,
  taskCount: number
}
```

### Domain regions

Every task is classified into one of 8 domain regions:

| Region | Examples |
|--------|----------|
| `code` | Writing functions, fixing bugs, refactoring, deployments |
| `writing` | Blog posts, emails, documentation, changelogs |
| `data-analysis` | CSV processing, dashboards, SQL queries, metrics |
| `planning` | Architecture, roadmaps, specs, sprint scoping |
| `research` | Investigation, benchmarking, comparison, audits |
| `qa` | Testing, validation, coverage, regression checks |
| `conversation` | Questions, explanations, discussions |
| `creative` | Design, brainstorming, prototyping, UI/UX |

Each region tracks task count, average quality score, most-used tools, and common task types.

### Concept attractors

Attractors are recurring patterns within a region. Three types:

| Type | What it captures |
|------|-----------------|
| `tool-pattern` | Tools frequently used together (e.g., GitHub + code review) |
| `task-type` | Common task patterns (e.g., "deploy and verify") |
| `quality-cluster` | Groups of tasks with similar quality outcomes |

Each attractor has a salience score (how distinctive it is) and a frequency count.

### Transformation rules

Rules describe relationships between regions:

- `shares-tools` — Two regions use overlapping tool sets
- `similar-structure` — Regions have similar task patterns
- `sequential` — Tasks in one region often follow tasks in another

### Context expansion

When a new task arrives, the expander classifies it, finds relevant attractors, follows transformation rules to adjacent regions, and returns suggested tools, domain knowledge, and relevant patterns. The expanded context is injected into the agent's planning prompt.

### Privacy

SCL performs pure structural analysis. The MindsetObject stores aggregate statistics (tool counts, quality scores, region distributions) — not task content, user messages, or deliverables.

## The Insights page

The dashboard's **/insights** page visualizes the MindsetObject: domain region distribution, top attractors per region, cross-region transformation links, quality trends, and task volume.

## Related docs

- [Getting Started](getting-started.md) — First task setup
- [Concepts](concepts.md) — Core platform concepts
- [Configuration](configuration.md) — Memory and SCL configuration options
