-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC

-- Routine harness fields on cron_jobs (Phase 0)
ALTER TABLE cron_jobs
    ADD COLUMN IF NOT EXISTS prompt         text,
    ADD COLUMN IF NOT EXISTS repo_url       text,
    ADD COLUMN IF NOT EXISTS branch_ref     text NOT NULL DEFAULT 'main',
    ADD COLUMN IF NOT EXISTS connector_ids  text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS notify_channel text;
