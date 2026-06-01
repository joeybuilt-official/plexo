-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
-- Migration 0124 — orchestrator fan-out fields
-- REQUIRES: tasks table (0000+)
-- NOTE: parent_id already exists (self-ref, SET NULL, indexed). This adds
--       the two fields needed for join-readiness detection and depth enforcement.
--
-- fanout_depth  — depth in the fan-out tree. 0 = root/parent, 1 = child.
--                 Enforced at dispatch: spawnFanout() rejects calls where
--                 parent.fanout_depth >= MAX_FANOUT_DEPTH (= 1), blocking
--                 grandchildren at the API level before any DB write.
-- fanout_total  — number of children the parent spawned. Set once at dispatch
--                 time. NULL = task is not a fan-out orchestrator. Used to
--                 validate join completeness: join fires when
--                 COUNT(*) WHERE parent_id = :id = fanout_total
--                 AND all are in terminal status.
--
-- DO NOT APPLY until operator approves (migration gate).

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS fanout_depth  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fanout_total  INTEGER;

-- Covering index for the join-poll query pattern:
--   SELECT id, status, outcome_summary, failure_reason
--   FROM tasks WHERE parent_id = :id
-- Existing tasks_parent_id_idx covers the lookup; this (parent_id, status)
-- composite avoids a seq-scan on the status filter when polling for terminal state.
CREATE INDEX IF NOT EXISTS tasks_fanout_join_idx
    ON tasks (parent_id, status)
    WHERE parent_id IS NOT NULL;
