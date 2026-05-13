# Workspace Memory and SCL

Plexo maintains workspace memory through two systems: a graph-shaped episodic memory store (Graphiti on Kuzu) and SCL (Structured Context Language), a structural compression system that builds a navigable concept map from task history.

## Graphiti memory pipeline

As of the 2026-05-12 21:40:40 UTC cutover, workspace memory writes and reads flow through Graphiti — a temporally-aware knowledge-graph engine — running in a Python sidecar with a per-workspace Kuzu graph backend.

See:
- [ADR 0010 — Graphiti adoption](../adr/0010-graphiti-adoption.md) (why Graphiti)
- [ADR 0011 — Python sidecar](../adr/0011-graphiti-python-sidecar.md) (sidecar architecture)
- [ADR 0013 — Cutover execution](../adr/0013-graphiti-cutover-execution.md) (live cutover)
- [ADR 0014 — Post-cutover cleanup re-split](../adr/0014-post-cutover-cleanup-resplit.md) (Phase F.1 / F.2 split)

### Writes

All writes go through the env-gated gateway at `packages/agent/src/memory/write-backend.ts`. Mode is selected via `MEMORY_WRITE_BACKEND`:

| Mode | Behavior |
|------|----------|
| `postgres` | Legacy path; inserts into `memory_entries` only |
| `dual` | Writes to both Graphiti and `memory_entries`; postgres is authoritative |
| `graphiti` | Graphiti-only; postgres insert skipped |

**Current prod value: `MEMORY_WRITE_BACKEND=graphiti`** (since 2026-05-12 21:40:40 UTC).

### Reads

Reads route through `packages/agent/src/memory/read-backend.ts`, gated by `MEMORY_READ_BACKEND` (`graphiti` or `postgres`). The Graphiti path is exposed as:

```ts
readFromGraphiti(opts: GraphitiSearchOpts): Promise<MemorySearchResult[] | null>
```

Results are mapped back into the existing `MemorySearchResult` shape so callers (planner, channel-ai, chat route, agent executor) do not change.

### Bridge layer

Both backends use `@plexo/graphiti-bridge` (`packages/graphiti-bridge/src/index.ts`), which wraps HMAC-signed HTTP calls to the sidecar. The bridge is constructed lazily; missing `PLEXO_GRAPHITI_SIDECAR_URL` / `PLEXO_SERVICE_KEY` degrades to postgres-only with a one-time warning.

### Sidecar

`services/graphiti-sidecar/main.py` runs FastAPI + `graphiti-core` 0.29 with the Kuzu backend. The sidecar owns episode ingestion, entity extraction, edge construction, and temporal search.

### Per-workspace isolation

Each workspace gets its own Kuzu graph at `/data/graphiti/<workspace-id>/`. No cross-workspace edges; queries are scoped by graph directory at the sidecar boundary.

### Legacy `memory_entries` (in transition)

The `memory_entries` Postgres table still exists. Phase F.1 (ADR 0014) migrated the planner's primary call site to the Graphiti bridge and removed dead clustering code, but **40+ peripheral call sites** still touch `memory_entries` directly via Drizzle or raw SQL — including divergence, suggest, knn, consolidation, conversation-bridge, several API routes, and the synthesis-nightly / confidence-lifecycle crons.

Phase F.2 drops the table after **30 consecutive days of zero new writes** (no `created_at > now() - 30d` rows). Storage cost in the meantime is ~57 MB — negligible. Stale-read risk on the legacy paths is acknowledged and accepted during the observation window.

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
