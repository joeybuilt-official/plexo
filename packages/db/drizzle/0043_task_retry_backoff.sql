-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add retry_after column for exponential backoff on failed task attempts.
-- Tasks with retry_after in the future are not claimable until that time.

ALTER TABLE tasks ADD COLUMN retry_after TIMESTAMPTZ;
