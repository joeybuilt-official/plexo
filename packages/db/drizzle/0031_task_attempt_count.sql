-- Phase 1 (P1·S3): Add attempt_count to tasks for retry tracking.
-- Rollback: ALTER TABLE tasks DROP COLUMN IF EXISTS attempt_count;
--           DROP INDEX IF EXISTS tasks_running_stale_idx;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

-- Partial index for the ghost task recovery query
CREATE INDEX IF NOT EXISTS tasks_running_stale_idx
    ON tasks (status, claimed_at)
    WHERE status = 'running';
