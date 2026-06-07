-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0128  Tag: 0128_routing_quality_linkage
--
-- Round-5 Phase 3 (ADR 0001): link the routing decision to the work outcome so
-- a D2 model flip can be measured instead of guessed.
--
-- 1. Denormalize the chosen provider/model onto `tasks` (write-once at dispatch).
--    The scorecard joins these to the existing `quality_score` (judge) column.
--    Additive, nullable, no backfill, no NOT NULL — write-on-new-rows only, so
--    the migration cannot lock/rewrite the hot `tasks` table (pre-mortem #2).
-- 2. `routing_events` — append-only sink replacing the console-only
--    `model.routed` telemetry stub. Pruned by runDataRetention() (pre-mortem #3).
-- 3. `shadow_extraction_results` — graphiti shadow re-extraction agreement
--    samples (operator chose ground-truth shadow over the cheap proxy). Default
--    sampling OFF; pruned by runDataRetention().
--
-- All statements IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — re-run safe.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS routed_provider TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS routed_model    TEXT;

-- Scorecard read: AVG(quality_score) GROUP BY routed_model WHERE type='extraction'.
CREATE INDEX IF NOT EXISTS tasks_routed_model_idx
    ON tasks(type, routed_model)
    WHERE routed_model IS NOT NULL;

CREATE TABLE IF NOT EXISTS routing_events (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL = global/undefined workspace (matches router-v2 stats convention).
    workspace_id         TEXT,
    -- NULL for proxy-only callers (graphiti) that create no task row.
    task_id              TEXT,
    task_type            TEXT        NOT NULL,
    -- NULL when the selector found no candidate (routing gap — still recorded).
    provider             TEXT,
    model                TEXT,
    fallback_engaged     BOOLEAN     NOT NULL DEFAULT false,
    selector_duration_ms INTEGER     NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routing_events_created_at_idx
    ON routing_events(created_at DESC);
CREATE INDEX IF NOT EXISTS routing_events_model_idx
    ON routing_events(task_type, model, created_at DESC);

CREATE TABLE IF NOT EXISTS shadow_extraction_results (
    id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id        TEXT,
    app_id              TEXT,
    primary_model       TEXT             NOT NULL,
    shadow_model        TEXT             NOT NULL,
    -- 0..1 agreement between primary + shadow extraction outputs.
    agreement_score     DOUBLE PRECISION NOT NULL,
    -- Secondary regression signal: extracted-field counts per side.
    primary_field_count INTEGER,
    shadow_field_count  INTEGER,

    created_at          TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_extraction_results_created_at_idx
    ON shadow_extraction_results(created_at DESC);
CREATE INDEX IF NOT EXISTS shadow_extraction_results_models_idx
    ON shadow_extraction_results(primary_model, shadow_model, created_at DESC);
