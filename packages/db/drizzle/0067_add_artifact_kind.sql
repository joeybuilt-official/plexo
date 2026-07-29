-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Phase 2 — Works: add `kind` + `meta` to artifacts.
--
-- `kind` is a first-class WorkKind taxonomy (markdown/instructions/code/
-- html/mockup/json/yaml/table/checklist/image/diagram/chart/config/
-- link-list/file). The legacy `type` column is kept for back-compat.
-- `meta` is a free-form jsonb payload for renderer hints (language,
-- preview mode, table columns, chart spec, ...).
--
-- Both columns are additive and nullable-friendly; applying this migration
-- on an existing DB never breaks existing reads.

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT '{}'::jsonb;

-- Best-effort backfill for rows that pre-date this column. Maps the
-- existing coarse `type` column onto the new taxonomy. Only touches rows
-- where kind is still NULL.
UPDATE artifacts
SET kind = CASE
    WHEN type = 'markdown' THEN 'markdown'
    WHEN type = 'code'     THEN 'code'
    WHEN type = 'diagram'  THEN 'diagram'
    WHEN type = 'html'     THEN 'html'
    WHEN type = 'image'    THEN 'image'
    ELSE 'file'
END
WHERE kind IS NULL;
