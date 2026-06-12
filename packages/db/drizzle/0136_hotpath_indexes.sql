-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0136  Tag: 0136_hotpath_indexes
--
-- arch-findings P1 — missing indexes on the three hottest append/poll tables.
--
--   * session_logs  — one row per request, the worst-growing table, had ZERO
--                     secondary indexes; every by-session / by-user / time-range
--                     read was a full scan.
--   * cron_jobs     — scheduler polls `enabled AND next_run_at <= NOW()` every
--                     tick; table had only a PK → seq scan per tick.
--   * tasks         — claim poller orders the queued set by (priority, created_at);
--                     the existing (status, retry_after) index does not cover the
--                     sort, so Postgres sorted the whole queued set in memory every
--                     poll.
--
-- APPLY NOTE: CREATE INDEX CONCURRENTLY must run OUTSIDE a transaction block.
-- Apply with `psql` directly (the project applies migrations manually — the
-- drizzle journal is not the source of truth past 0129). Do NOT wrap in BEGIN/COMMIT.
-- Each statement is idempotent (IF NOT EXISTS) and individually re-runnable.

CREATE INDEX CONCURRENTLY IF NOT EXISTS session_logs_session_created_idx
    ON session_logs (session_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS session_logs_user_idx
    ON session_logs (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS session_logs_created_idx
    ON session_logs (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cron_jobs_enabled_next_run_idx
    ON cron_jobs (enabled, next_run_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_status_priority_created_idx
    ON tasks (status, priority, created_at);
