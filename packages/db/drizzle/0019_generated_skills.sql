-- 0019: Add is_generated flag to connections_registry
-- Supports auto-generated connections created by the agent synthesizer.

ALTER TABLE connections_registry
    ADD COLUMN IF NOT EXISTS is_generated BOOLEAN NOT NULL DEFAULT FALSE;

-- Unique index on plugins(workspace_id, name) — enables upsert during re-synthesis.
CREATE UNIQUE INDEX IF NOT EXISTS plugins_workspace_name_uq
    ON plugins (workspace_id, name);
