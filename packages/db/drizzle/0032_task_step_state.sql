-- Phase 2 (P2·S1): Add step_state and is_terminal to task_steps for checkpointing.
-- Rollback: ALTER TABLE task_steps DROP COLUMN IF EXISTS step_state;
--           ALTER TABLE task_steps DROP COLUMN IF EXISTS is_terminal;

ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS step_state JSONB;
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS is_terminal BOOLEAN NOT NULL DEFAULT FALSE;
