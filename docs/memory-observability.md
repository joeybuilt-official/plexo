# Memory System Observability

The atomic-fact memory pipeline emits eight `plexo_ops_analytics` events that
cover ingest, retrieval, caching, and lifecycle jobs end-to-end.

All emitters live in `packages/agent/src/analytics/memory-events.ts`. Every
emitter is fire-and-forget — observability never blocks or breaks the caller.

The underlying table is `plexo_ops_analytics(app, event_name, properties, instance_uuid, created_at)`.
Workspace and user IDs are stored inside the `properties` JSON, not as top-level
columns.

## Events

| Event | Trigger | Emitter call site |
|---|---|---|
| `memory.extraction` | extract-worker finishes a turn (zero or more facts written) | `packages/agent/src/memory/extract-worker.ts` |
| `memory.embedded` | embedding written to `memory_entries.embedding` | `packages/agent/src/memory/extract-worker.ts` |
| `memory.retrieval` | `queryMemory()` returns (success or empty) | `packages/agent/src/memory/query.ts` |
| `memory.cache-hit` | search-result Valkey cache served the query | `packages/agent/src/memory/store.ts` |
| `memory.cache-miss` | search-result cache returned null, query fell through to DB | `packages/agent/src/memory/store.ts` |
| `memory.retrieval-flush` | `flushRetrievalCounts` cron pass completed | `apps/api/src/cron/confidence-lifecycle.ts` |
| `memory.confidence-decay` | weekly `decayConfidence` cron pass completed | `apps/api/src/cron/confidence-lifecycle.ts` |
| `memory.user-write` | explicit user instruction persisted as a behavior rule | `packages/agent/src/memory/conversation-bridge.ts` |

## Payload shapes

```jsonc
// memory.extraction
{ "workspace_id": "...", "facts_extracted": 2, "facts_written": 2, "source": "telegram", "session_id": "..." }

// memory.embedded
{ "workspace_id": "...", "fact_id": "...", "dimensions": 1536, "latency_ms": 412 }

// memory.retrieval
{ "workspace_id": "...", "user_id": "..." | null, "mode": "vector" | "keyword" | "hybrid", "result_count": 5, "latency_ms": 88 }

// memory.cache-hit / memory.cache-miss
{ "workspace_id": "...", "cache_kind": "search" }

// memory.retrieval-flush
{ "cooled_count": 12, "frozen_count": 3 }

// memory.confidence-decay
{ "decayed_count": 1842, "factor": 0.9, "floor": 0.1 }

// memory.user-write
{ "workspace_id": "...", "rule_key": "conv.abc.xyz", "rule_type": "communication_style", "conditional": false }
```

## Operational queries

Recent memory activity (replace `INTERVAL` to suit):

```sql
SELECT event_name,
       properties,
       created_at
FROM plexo_ops_analytics
WHERE event_name LIKE 'memory.%'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 50;
```

Extraction rate per workspace (last 24h):

```sql
SELECT properties->>'workspace_id' AS workspace_id,
       COUNT(*) FILTER (WHERE event_name = 'memory.extraction') AS turns,
       SUM((properties->>'facts_written')::int) FILTER (WHERE event_name = 'memory.extraction') AS facts_written,
       COUNT(*) FILTER (WHERE event_name = 'memory.embedded') AS embeddings_written
FROM plexo_ops_analytics
WHERE event_name LIKE 'memory.%'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY facts_written DESC NULLS LAST;
```

Cache performance (last 24h):

```sql
SELECT properties->>'workspace_id' AS workspace_id,
       COUNT(*) FILTER (WHERE event_name = 'memory.cache-hit') AS hits,
       COUNT(*) FILTER (WHERE event_name = 'memory.cache-miss') AS misses,
       ROUND(
         COUNT(*) FILTER (WHERE event_name = 'memory.cache-hit')::numeric
         / NULLIF(COUNT(*) FILTER (WHERE event_name IN ('memory.cache-hit','memory.cache-miss')), 0),
         3
       ) AS hit_rate
FROM plexo_ops_analytics
WHERE event_name IN ('memory.cache-hit','memory.cache-miss')
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY hits DESC;
```

Retrieval latency (last hour):

```sql
SELECT mode,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY (properties->>'latency_ms')::int) AS p50_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (properties->>'latency_ms')::int) AS p95_ms,
       COUNT(*)                                                                         AS n
FROM plexo_ops_analytics,
     LATERAL (SELECT properties->>'mode' AS mode) m
WHERE event_name = 'memory.retrieval'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY mode;
```

Lifecycle job health (most recent run of each):

```sql
SELECT DISTINCT ON (event_name)
       event_name,
       created_at AS last_run,
       properties
FROM plexo_ops_analytics
WHERE event_name IN ('memory.retrieval-flush', 'memory.confidence-decay')
ORDER BY event_name, created_at DESC;
```

## Adding a new event

1. Add a typed emit function to `packages/agent/src/analytics/memory-events.ts`.
2. Call it fire-and-forget (`void emitX(...)`) from the relevant code path.
3. Add the event to the table above and document the payload shape.
4. Update `packages/agent/src/routes/__tests__/channel-bridge-coverage.test.ts`-style
   gates if the emit is part of a critical path that must never silently drop.
