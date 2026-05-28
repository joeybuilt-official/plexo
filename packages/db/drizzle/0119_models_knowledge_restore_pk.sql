-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Migration 0119 — restore PRIMARY KEY on models_knowledge.id
--
-- Schema (packages/db/src/schema.ts:1200) and the initial creation
-- migrations (0015 + 0016) declare `id text PRIMARY KEY NOT NULL`, but the
-- live the server-prod table has zero constraints (verified 2026-05-28: pg_constraint
-- returns 0 rows for the relation). Without the PK, the knowledge-sync
-- upsert path (packages/agent/src/providers/knowledge.ts:130) fails on every
-- scheduled-jobs cycle with PostgresError 42P10
-- ("there is no unique or exclusion constraint matching the ON CONFLICT
-- specification").
--
-- 0065_code_health_schema_fixes added a dedupe DELETE for the same table
-- (anticipating a pg_dump restore that would carry duplicates), but did not
-- re-add the PK. This migration finishes the job.
--
-- All statements are idempotent / no-op on a clean DB.

-- 1. Dedupe — keep the higher-ctid (most-recently-inserted) row per id.
--    Required because the live table has 601 rows / 523 distinct ids (78 dupes
--    as of 2026-05-28); ALTER TABLE ... ADD PRIMARY KEY would otherwise fail.
DELETE FROM models_knowledge a
    USING models_knowledge b
    WHERE a.id = b.id
      AND a.ctid < b.ctid;

-- 2. Add PK. Idempotent — skips if a primary key already exists.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'models_knowledge'::regclass
          AND contype = 'p'
    ) THEN
        ALTER TABLE models_knowledge ADD PRIMARY KEY (id);
    END IF;
END$$;
