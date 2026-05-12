-- Phase 2b of the intelligence overhaul.
-- Per-task-type ranked fallback chains for the Settings → Intelligence
-- → Routing UI. Each (workspace, task_type) holds an ordered list of
-- (provider_instance, model_id) rows that the IntelligentRouter walks
-- in `position` order, falling through on failure.
--
-- Smart-default backfill is intentionally NOT in this migration — it
-- runs at API container startup via the seed-routing-chains helper so
-- it can use the live model-attributes heuristics + per-workspace
-- enabled-providers context. Idempotent via the unique index below.
--
-- NO DATA LOSS — additive migration, IF NOT EXISTS guards on every
-- DDL statement, no DROPs.

CREATE TABLE IF NOT EXISTS routing_chains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_type text NOT NULL,
    provider_id uuid NOT NULL REFERENCES provider_instances(id) ON DELETE CASCADE,
    model_id text NOT NULL,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routing_chains_ws_task_pos
    ON routing_chains(workspace_id, task_type, position);

CREATE INDEX IF NOT EXISTS routing_chains_ws_task
    ON routing_chains(workspace_id, task_type);
