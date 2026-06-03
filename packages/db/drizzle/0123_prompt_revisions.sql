-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
-- Migration 0123 — prompt_revisions table for distillation retro agent
-- REQUIRES: cron_jobs (0001+), outcome_records (0122)

CREATE TABLE IF NOT EXISTS prompt_revisions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    routine_id          UUID        NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    version             INTEGER     NOT NULL,
    base_prompt_hash    TEXT        NOT NULL,
    proposed_diff       TEXT        NOT NULL,
    rationale           TEXT        NOT NULL,
    source_outcome_ids  UUID[]      NOT NULL DEFAULT '{}',
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','applied','stale','expired')),
    reviewed_by         TEXT,
    reviewed_at         TIMESTAMPTZ,
    applied_at          TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS prompt_revisions_routine_version_idx
    ON prompt_revisions (routine_id, version);

CREATE INDEX IF NOT EXISTS prompt_revisions_pending_idx
    ON prompt_revisions (routine_id, expires_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS prompt_revisions_routine_ts_idx
    ON prompt_revisions (routine_id, ts DESC);
