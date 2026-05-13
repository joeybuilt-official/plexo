-- 0097_themes_phase3.sql — Phase 3 of unified Knowledge Graph + SCL system.
-- Adds:
--   - memory_themes.is_scl_evidence jsonb (gate-pass evidence per Phase 3 spec)
--   - memory_theme_history (per-run snapshot used by SCL gate #1: stability across
--     ≥3 consecutive runs with member-Jaccard ≥0.6).
-- Idempotent (IF NOT EXISTS).

ALTER TABLE memory_themes
  ADD COLUMN IF NOT EXISTS is_scl_evidence jsonb;

CREATE TABLE IF NOT EXISTS memory_theme_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES memory_theme_runs(id) ON DELETE CASCADE,
  stable_id    text NOT NULL,
  theme_id     uuid NOT NULL,
  level        smallint NOT NULL,
  member_ids   uuid[] NOT NULL,
  size         integer NOT NULL,
  coherence    real NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_theme_history_workspace_stable_idx
    ON memory_theme_history(workspace_id, stable_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS memory_theme_history_run_idx
    ON memory_theme_history(run_id);
