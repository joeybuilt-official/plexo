-- Phase 7: confidence-decay heatmap materialization table.
-- Populated/updated by the nightly decay cron (confidence-lifecycle.ts).
-- Primary key ensures one row per (workspace, tier, band); upsert is safe on re-run.
CREATE TABLE IF NOT EXISTS memory_tier_stats (
    workspace_id    UUID        NOT NULL,
    tier            TEXT        NOT NULL CHECK (tier IN ('hot', 'active', 'cold')),
    confidence_band TEXT        NOT NULL CHECK (confidence_band IN ('0-20', '20-40', '40-60', '60-80', '80-100')),
    count           INTEGER     NOT NULL DEFAULT 0,
    last_decay_at   TIMESTAMPTZ,
    PRIMARY KEY (workspace_id, tier, confidence_band)
);
