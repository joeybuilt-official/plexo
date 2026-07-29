-- SPDX-License-Identifier: MIT
-- Idx: 0127  Tag: 0127_router_v2_stats
--
-- Router-v2 per-(workspace, provider, model, task_type) call stats, persisted
-- so observability survives an API deploy (in-memory stats reset every restart)
-- and so multiple API instances' views can be aggregated at read time.
--
-- Append-only time series: a snapshot cron inserts the current in-memory state
-- of each live bucket on a fixed cadence. Each row is one bucket at one instant;
-- the latest snapshot per key is the current state, older rows give history.
-- Additive + IF NOT EXISTS — a no-op-safe forward migration.
--
-- workspace_id is TEXT (not UUID FK): the in-memory key uses NULL for the
-- global/undefined scope, and storing the raw key value avoids a bad-cast
-- aborting the snapshot insert if a non-UUID scope ever appears.

CREATE TABLE IF NOT EXISTS router_v2_stats (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Scope of the bucket. NULL = global/undefined workspace.
    workspace_id            TEXT,
    provider                TEXT        NOT NULL,
    model                   TEXT        NOT NULL,
    task_type               TEXT        NOT NULL,

    -- Snapshot of the rolling-window ReadStats at snapshot_at.
    sample_count            INTEGER     NOT NULL,
    success_rate            DOUBLE PRECISION NOT NULL,
    latency_p50_ms          INTEGER     NOT NULL,
    latency_p95_ms          INTEGER     NOT NULL,
    recent_failure_penalty  DOUBLE PRECISION NOT NULL,
    -- When the bucket is back in the pool; NULL when not in cooldown.
    cooldown_end_at         TIMESTAMPTZ,

    snapshot_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-state lookup per bucket key (dashboard reads the most recent snapshot).
CREATE INDEX IF NOT EXISTS router_v2_stats_key_idx
    ON router_v2_stats(provider, model, task_type, snapshot_at DESC);

-- Retention pruning + time-series scans.
CREATE INDEX IF NOT EXISTS router_v2_stats_snapshot_at_idx
    ON router_v2_stats(snapshot_at DESC);
