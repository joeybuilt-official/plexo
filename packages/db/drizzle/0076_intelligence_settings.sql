-- Phase 0 of the intelligence overhaul.
-- Workspace-level JSONB column for the unified intelligence stack settings.
-- Subsequent phases (1-6) populate keys inside this column. Phase 0 only
-- adds the column so later phases have somewhere to write.
--
-- NO DATA LOSS — additive migration. Existing workspaces get '{}' default.

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS intelligence_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS workspaces_intelligence_settings_idx
    ON workspaces USING gin (intelligence_settings);
