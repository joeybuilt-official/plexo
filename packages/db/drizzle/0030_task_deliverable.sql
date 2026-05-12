-- Phase 0 (P0·S3): Add structured deliverable output to tasks table.
-- Rollback: ALTER TABLE tasks DROP COLUMN IF EXISTS deliverable;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deliverable JSONB;

-- Partial index for querying tasks by deliverable outcome
CREATE INDEX IF NOT EXISTS tasks_deliverable_outcome_idx
    ON tasks ((deliverable->>'outcome'))
    WHERE deliverable IS NOT NULL;
