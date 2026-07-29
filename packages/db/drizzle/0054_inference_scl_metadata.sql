-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Extend inference_logs with SCL structural metadata, consent, and PII-scrubbed patterns.
-- Table has 2 rows in production — lightweight migration.

ALTER TABLE inference_logs
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS regions_activated TEXT[],
    ADD COLUMN IF NOT EXISTS resolution_level TEXT,
    ADD COLUMN IF NOT EXISTS context_budget_used INTEGER,
    ADD COLUMN IF NOT EXISTS accepted BOOLEAN,
    ADD COLUMN IF NOT EXISTS scrub_input_pattern TEXT,
    ADD COLUMN IF NOT EXISTS scrub_output_pattern TEXT,
    ADD COLUMN IF NOT EXISTS training_consent BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS inference_logs_workspace_idx ON inference_logs(workspace_id);
CREATE INDEX IF NOT EXISTS inference_logs_consent_idx ON inference_logs(training_consent) WHERE training_consent = TRUE;
