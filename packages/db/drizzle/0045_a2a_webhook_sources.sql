-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add 'a2a' and 'webhook' to task_source enum for A2A protocol
-- and generic webhook trigger support.

ALTER TYPE task_source ADD VALUE IF NOT EXISTS 'a2a';
ALTER TYPE task_source ADD VALUE IF NOT EXISTS 'webhook';
