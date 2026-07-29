-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add Golden Record storage to workspace_mindsets.
-- Lightweight migration: nullable column, no backfill.
-- workspace_mindsets table has 0 rows in production.

ALTER TABLE workspace_mindsets
    ADD COLUMN IF NOT EXISTS golden_record JSONB,
    ADD COLUMN IF NOT EXISTS golden_record_version TEXT;
