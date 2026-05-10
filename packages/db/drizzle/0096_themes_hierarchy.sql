-- 0096_themes_hierarchy.sql — Phase 1 of unified Knowledge Graph + SCL system.
-- Adds 3-level theme hierarchy (region/theme/subtheme), kNN edge cache,
-- run-history bookkeeping, plus is_scl flag (Phase 3 will populate).
ALTER TABLE memory_themes
  ADD COLUMN IF NOT EXISTS parent_id    uuid REFERENCES memory_themes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS level        smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stable_id    text,
  ADD COLUMN IF NOT EXISTS is_scl       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exemplar_ids uuid[],
  ADD COLUMN IF NOT EXISTS why          text,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS memory_themes_parent_idx ON memory_themes(parent_id);
CREATE INDEX IF NOT EXISTS memory_themes_level_idx  ON memory_themes(workspace_id, level);
CREATE INDEX IF NOT EXISTS memory_themes_stable_idx ON memory_themes(workspace_id, stable_id);
CREATE INDEX IF NOT EXISTS memory_themes_is_scl_idx ON memory_themes(workspace_id) WHERE is_scl;

CREATE TABLE IF NOT EXISTS memory_knn_edges (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  a_id         uuid NOT NULL,
  b_id         uuid NOT NULL,
  weight       real NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, a_id, b_id)
);
CREATE INDEX IF NOT EXISTS memory_knn_edges_a_idx ON memory_knn_edges (workspace_id, a_id);

CREATE TABLE IF NOT EXISTS memory_theme_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  n_entries    int  NOT NULL,
  n_themes     int  NOT NULL,
  n_subthemes  int  NOT NULL,
  duration_ms  int  NOT NULL,
  algo_version text NOT NULL
);
