# Valkey / Redis Key Schema

Canonical inventory of every key pattern Plexo writes to Valkey/Redis.
Verified live against the codebase as of Phase 5 (post-memory-rebuild cleanup).
Stale SCL/mindset/golden-record patterns have been audited out — see
`scripts/flush-stale-memory-keys.ts` for the safety-net flush.

## Active key patterns

| Key pattern | Source (file:line) | TTL | Purpose |
|---|---|---|---|
| `plexo:memory:{workspaceId}:prefs` | `packages/agent/src/memory/store.ts:75-76` | `PREF_TTL` | Workspace memory-preference cache |
| `plexo:memory:{workspaceId}:search:{type}:{query}` | `packages/agent/src/memory/store.ts:71-72` | `SEARCH_TTL` | Memory search-result cache |
| `plexo:introspect:{workspaceId}` | `apps/api/src/routes/introspect.ts:42-44` | `TTL_SECONDS` | `buildIntrospectionSnapshot` cache |
| `plexo:spend:{workspaceId}:{YYYY-MM}` | `packages/agent/src/cost-gate.ts:102-105` | `SPEND_KEY_TTL_SEC` (35 days) | Monthly spend counter (atomic) |
| `plexo:system:latest_version` | `apps/api/src/routes/system.ts:30` | `VERSION_CACHE_TTL` | Latest version lookup cache |
| `plexo:system:latest_commit` | `apps/api/src/routes/system.ts:33` | `COMMIT_CACHE_TTL` | Latest commit lookup cache |
| `plexo:system:update_pending_commit` | `apps/api/src/routes/system.ts:31` | — | Pending self-update target commit |
| `health-monitor:state` | `apps/api/src/health-monitor.ts:17` | unbounded | Per-service health state snapshot |
| `health-monitor:timeline` | `apps/api/src/health-monitor.ts:18` | trimmed to `MAX_TIMELINE_ENTRIES` (200) | Health-transition event ring buffer |
| `owd:{id}` | `packages/agent/src/one-way-door.ts:86-88` | `OWD_TTL_SECONDS` / 600s | One-way-door approval records |
| `owd:{taskId}:ack` | `apps/api/src/sse-emitter.ts:114` | 300s | SSE task acknowledgment |
| `zeroclaw:parallel:slots` | `apps/api/src/parallel-executor.ts` (hash) | unbounded | Parallel executor slot map |
| `ws_rate:{workspaceId}` | `apps/api/src/middleware/workspace-rate-limit.ts:56` | `WINDOW_SECS` | Per-workspace rate-limit counter |
| `ws_rate_limit:{workspaceId}` | `apps/api/src/middleware/workspace-rate-limit.ts:65` | 60s | Cached per-workspace limit value |
| `sso:used:{token}` | `apps/api/src/sso/token.ts:41` | `USED_KEY_TTL_SECONDS` | SSO token replay prevention |
| `analytics:last_payload:{instanceId}` | `apps/api/src/analytics/config.ts:143` | 30 days | Last analytics payload (debugging) |

## Removed (pre-rebuild) patterns

The following patterns were used by the SCL/mindset memory system before the
atomic-fact rebuild. They are not written by any current code. The flush
script `scripts/flush-stale-memory-keys.ts` SCANs and DELs these in deployed
instances as a one-time cleanup.

- `mindset:*`
- `golden-record:*` / `golden_record:*`
- `scl:*`
- `workspace_mindsets:*`
- `attractor:*`

## Operational notes

- All "current system" keys above are safe — never include them in flush patterns.
- The flush script is **safe to re-run**: SCAN+DEL on patterns that match nothing is a no-op.
- Auth: production Valkey requires `REDIS_PASSWORD` from `.env`. Pass via `REDIS_URL` when running scripts on the host:
  ```bash
  REDIS_URL="redis://:${REDIS_PASSWORD}@localhost:6379" pnpm tsx scripts/flush-stale-memory-keys.ts
  ```
- Do **not** run the flush script against production without operator sign-off.
