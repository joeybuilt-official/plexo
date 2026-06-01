-- DRAFT — DO NOT APPLY — awaiting operator approval
-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0122  Tag: 0122_outcome_records
--
-- Creates outcome_records table for the learning foundation.
-- Stores one row per terminal task: what was attempted, what happened,
-- and (optionally) what a human thought of it.
--
-- ground_truth enum:
--   test_pass   — automated test suite passed after the task's changes
--   pr_merged   — the PR the task opened was merged by a human
--   pr_reverted — the PR was reverted after merge (negative signal)
--   human_accept — Telegram accept signal (positive)
--   human_reject — Telegram reject signal (negative)
--   null        — no signal captured yet

CREATE TYPE outcome_ground_truth AS ENUM (
    'test_pass',
    'pr_merged',
    'pr_reverted',
    'human_accept',
    'human_reject'
);

CREATE TABLE IF NOT EXISTS outcome_records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Links back to the routine that triggered this task (nullable — not all tasks
    -- come from routines; standalone tasks still get an outcome record).
    routine_id  UUID REFERENCES cron_jobs(id) ON DELETE SET NULL,

    -- The task that was executed.
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

    -- What fired the task: 'cron' | 'github' | 'user' | 'telegram' | ...
    trigger     TEXT NOT NULL,

    -- Human or automated quality signal. NULL until a signal arrives.
    ground_truth outcome_ground_truth,

    -- Free-form LLM-generated summary of what the task did (≤2000 chars).
    -- Written by the executor on terminal state from outcomeSummary.
    summary     TEXT,

    -- When the task reached its terminal state.
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup: all outcomes for a routine (for learning distillation agent)
CREATE INDEX outcome_records_routine_idx ON outcome_records(routine_id) WHERE routine_id IS NOT NULL;

-- Fast lookup: all outcomes for a task (for Telegram reply handler to find the record)
CREATE UNIQUE INDEX outcome_records_task_idx ON outcome_records(task_id);

-- Fast lookup: unresolved outcomes (ground_truth IS NULL) for signal ingestion
CREATE INDEX outcome_records_pending_idx ON outcome_records(ts DESC) WHERE ground_truth IS NULL;
