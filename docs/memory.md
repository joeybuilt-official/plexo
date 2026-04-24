# Workspace Memory and SCL

Plexo maintains workspace memory through two systems: a traditional memory store (pgvector embeddings) and SCL (Structured Context Language), a structural compression system that builds a navigable concept map from task history.

## Traditional memory

Task outcomes, user instructions, and behavioral patterns are stored in PostgreSQL with pgvector embeddings. Entries are tiered by retrieval frequency:

| Tier | Behavior |
|------|----------|
| Hot | Frequently retrieved, always included in search |
| Active | Normal retrieval priority |
| Cold | Excluded from search, retained for archival |

The agent retrieves relevant memory during planning via vector similarity search (HNSW index) with an ILIKE text fallback. A Redis cache layer avoids redundant embedding lookups.

## SCL: Structured Context Language

SCL compresses workspace task history into a fixed-size generative structure called the MindsetObject. Unlike traditional memory that stores individual facts, the MindsetObject represents the workspace's accumulated patterns as a navigable concept space.

### How it works

1. **Extraction** -- After each task, inference logs are analyzed for tool usage patterns, task types, and quality scores
2. **Classification** -- Each log is classified into a domain region using lightweight keyword matching (no LLM calls)
3. **Compression** -- Domain regions are aggregated into the MindsetObject with concept attractors and transformation rules
4. **Expansion** -- At task start, the MindsetObject is expanded into relevant context: suggested tools, domain knowledge, and patterns from similar past work

The entire pipeline is structural analysis. No LLM is used for compression or classification. This keeps memory costs at zero tokens and eliminates hallucination risk in the memory layer.

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

- `shares-tools` -- Two regions use overlapping tool sets
- `similar-structure` -- Regions have similar task patterns
- `sequential` -- Tasks in one region often follow tasks in another

These rules help the expander predict which tools and patterns will be useful for a new task based on its domain region.

### Context expansion

When a new task arrives, the expander:

1. Classifies the task into a domain region
2. Finds relevant attractors in that region
3. Follows transformation rules to adjacent regions
4. Returns suggested tools, domain knowledge, and relevant patterns

The expanded context is injected into the agent's planning prompt, giving it awareness of workspace patterns without loading raw history.

### Privacy

SCL performs pure structural analysis. The MindsetObject stores aggregate statistics (tool counts, quality scores, region distributions) -- not task content, user messages, or deliverables. No task text is retained in the mindset structure.

## The Insights page

The dashboard includes an **/insights** page that visualizes the MindsetObject:

- Domain region distribution and activity
- Top concept attractors per region
- Cross-region transformation links
- Quality trends over time
- Task volume and pattern evolution

## Related docs

- [Getting Started](getting-started.md) -- First task setup
- [Concepts](concepts.md) -- Core platform concepts
- [Configuration](configuration.md) -- Memory and SCL configuration options
