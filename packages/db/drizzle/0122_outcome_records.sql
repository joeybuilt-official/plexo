-- SPDX-License-Identifier: AGPL-3.0-only
-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0122  Tag: 0122_outcome_records
--
-- Outcome records: one row per terminal task.
--
-- Two independent signal columns:
--   automated_outcome — written by the executor when the task reaches a
--     terminal state. Values: 'complete' | 'failed' | 'cost_ceiling' |
--     'no_credential' | 'cancelled'. TEXT with CHECK for evolution without
--     migrations (add new values without ALTER TYPE).
--
--   human_verdict — written when a human responds to the Telegram delivery
--     (✓ = 'accept', ✗ = 'reject'). Values: 'accept' | 'reject'.
--     Separate column so automated_outcome is never overwritten by a human
--     signal and both signals are independently queryable.
--
-- task_id is NULLABLE (ON DELETE SET NULL): if the task row is pruned,
-- the outcome record is retained for the learning loop — the task data
-- (summary, trigger, routine_id) is already denormalized here.

CREATE TABLE IF NOT EXISTS outcome_records (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Routine that triggered this task. NULL for ad-hoc tasks.
    routine_id          UUID        REFERENCES cron_jobs(id) ON DELETE SET NULL,

    -- Task that was executed. Nullable so pruning tasks doesn't destroy outcomes.
    task_id             TEXT        REFERENCES tasks(id) ON DELETE SET NULL,

    -- What fired the task: 'cron' | 'github' | 'user' | 'telegram' | ...
    trigger             TEXT        NOT NULL,

    -- Executor-written terminal state.
    automated_outcome   TEXT        CHECK (automated_outcome IN (
                                        'complete', 'failed',
                                        'cost_ceiling', 'no_credential', 'cancelled'
                                    )),

    -- Human verdict arriving via Telegram reply → inject path.
    human_verdict       TEXT        CHECK (human_verdict IN ('accept', 'reject')),

    -- LLM-generated summary of what the task did (≤2000 chars).
    summary             TEXT,

    -- When the task reached its terminal state.
    ts                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup: all outcomes for a routine (learning distillation agent).
CREATE INDEX IF NOT EXISTS outcome_records_routine_idx
    ON outcome_records(routine_id)
    WHERE routine_id IS NOT NULL;

-- Lookup: outcome by task_id (Telegram reply handler needs this).
-- Not UNIQUE — task_id is nullable and can match NULL multiple times in PG,
-- so uniqueness is enforced at application level (insert-if-not-exists).
CREATE INDEX IF NOT EXISTS outcome_records_task_idx
    ON outcome_records(task_id)
    WHERE task_id IS NOT NULL;

-- Lookup: rows awaiting human verdict (signal ingestion queue).
CREATE INDEX IF NOT EXISTS outcome_records_pending_verdict_idx
    ON outcome_records(ts DESC)
    WHERE human_verdict IS NULL AND automated_outcome = 'complete';

-- Lookup: failed tasks for the distillation agent to learn from.
CREATE INDEX IF NOT EXISTS outcome_records_failed_idx
    ON outcome_records(ts DESC)
    WHERE automated_outcome = 'failed';
