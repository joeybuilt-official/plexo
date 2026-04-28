# Plexo Stabilization

Proactive monitoring agents and self-correcting error layer.

## Agents

10 monitoring agents probe known failure modes every 5 minutes. Source lives
in `apps/api/src/stabilization/agents/` (kept inside `apps/api` so the API
tsconfig `rootDir` includes it; ops dir would be outside).

| Name | Probe | Severity floor |
|------|-------|----------------|
| `embedder-health` | `/health` + dim assertion (384) on local embedder | critical |
| `bridge-auth` | service-key probe to every registered PEX bridge | critical |
| `cluster-coverage` | % of `memory_patterns` with non-null embedding (>=90%) | warn |
| `cron-late` | any enabled cron not fired within 2x its interval | error |
| `synthesis-suggestions-stale` | `synthesis_suggestions` latest > 48h old | warn |
| `db-migration-drift` | drizzle ledger count vs on-disk migration files | critical |
| `route-error-rate` | any route 5xx rate > 5% (>=20 samples) | error |
| `memory-coherence-low` | rerun-over-rerun coherence drop > 10% | warn |
| `karakeep-ingest-stalled` | Karakeep bookmarks not ingested in 24h | warn |
| `disk-fill` | `/var/lib/docker` (or `PLEXO_DISK_PATH`) > 85% used | critical |

Alerts are appended to `ops/stabilization/alerts/YYYY-MM-DD.jsonl`. Sample
output in `alerts/sample.jsonl`.

## Self-heal

`apps/api/src/stabilization/self-heal.ts` provides:

- `withSelfHeal(fn, opts)` — bounded retry wrapper for any async fn.
- `selfHealMiddleware()` — Express middleware: catches recoverable errors
  (`ENOTFOUND`, `ECONNRESET`, 502/503/504) on idempotent routes and
  surfaces a `503 Retry-After: 1` so well-behaved clients (and the
  ghost-recovery loop) re-issue.

Mounted before the global error handler in `apps/api/src/index.ts`.

## Wiring

The agents are scheduled by the existing crash-resilient internal cron
(`apps/api/src/cron.ts` → `INTERNAL_JOBS` → `__internal_stabilization_agents`),
so they run every 5 minutes and survive restarts.

## Scope

This Romeo work delivers:

- 10 monitoring agents
- Self-healing middleware
- Sample alert format
- Cron wiring

Deferred:

- `apps/saas` admin dashboard (no `apps/saas/` exists yet — `apps/web` is
  the only frontend; would need a dedicated UI sprint).
