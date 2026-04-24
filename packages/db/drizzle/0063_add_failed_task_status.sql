-- Add 'failed' to task_status enum (was missing, code already writes it)
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'failed' AFTER 'complete';
