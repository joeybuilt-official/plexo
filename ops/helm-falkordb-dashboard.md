# Helm dashboard widget — FalkorDB observability (DEFERRED)

**Status:** Stub. Phase G/E in `falkordb-migration/plan.md` deferred the
actual widget implementation to Phase D3 (Helm operations graph), because
the Helm app's dashboard renderer lives in the helm repo, not plexo.

This doc captures the metrics + alert thresholds the widget should consume
so when D3 lands the implementer doesn't have to re-derive them.

Related: ADR 0016 (Failure A — backend bottleneck), ADR 0030 (this phase).

## Source

The graphiti-sidecar emits sampled (1% by default; `TELEMETRY_SAMPLE_RATE`)
structured stdout JSON of the form:

```json
{
  "event": "falkordb.write",
  "app": "plexo",
  "workspace_id": "<uuid>",
  "endpoint": "/v1/episodes",
  "lock_wait_ms": 12,
  "write_ms": 28341,
  "result_size": 7
}
```

Plexo's existing telemetry pipeline ships container stdout to loki via
promtail. Metric extraction happens in loki/promtail config, not in the
sidecar.

## Metrics the widget needs

| Metric | Source | Notes |
|---|---|---|
| `falkordb_command_latency_p99_ms` | percentile over `write_ms` | per `endpoint` |
| `lock_wait_ms_p95` | percentile over `lock_wait_ms` | per workspace_id |
| `cypher_query_count_by_app` | count of events | grouped by `app` |
| `result_size_p50` | median over `result_size` | sanity check on extraction yield |
| `falkordb_writes_per_minute_per_app` | rate of events | grouped by `app` |

The 1% sample rate means raw counts must be multiplied by ~100 for absolute
volume estimates. Latency percentiles are unaffected by sampling at the
sample sizes we expect (>1000 sampled writes/day at steady state).

## Alert thresholds (from ADR 0016 + ADR 0030)

| Alert | Condition | Why |
|---|---|---|
| `falkordb-latency-p99-high` | `falkordb_command_latency_p99_ms > 5000` for 5 min | ADR 0016 Failure A; signals write-throughput saturation |
| `falkordb-lock-wait-stacking` | `lock_wait_ms_p95 > 30000` for 5 min | per-workspace lock starvation; check whether one workspace is monopolizing the sidecar |
| `falkordb-write-zero` | `falkordb_writes_per_minute_per_app == 0` for 30 min during business hours | sidecar dead OR all callers down; check container health |
| `falkordb-backup-stale` | newest file in `/var/backups/falkordb/` > 36h old | nightly snapshot cron broken |

`falkordb-backup-stale` is host-level, not derived from sidecar logs. The
helm widget should surface it alongside the latency metrics.

## Widget layout (sketch)

- Top row: latency p99 / lock wait p95 / writes per minute (3 line charts, 24h)
- Middle: top 5 workspaces by lock_wait_ms (table)
- Bottom: backup file freshness (timestamp + age, red if >36h)

## When this lands for real

Phase D3 builds the helm operations graph; implementer should also wire this
widget into the helm dashboard at the same time, using the metrics + alerts
above. Delete this stub when the real widget ships.
