-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Drift warning persistence for SCL spirit-layer protection.
-- Lightweight: new table, no data backfill.

CREATE TABLE IF NOT EXISTS scl_drift_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    attractor_id TEXT NOT NULL,
    attractor_label TEXT NOT NULL,
    current_position JSONB NOT NULL,
    proposed_position JSONB NOT NULL,
    semantic_distance REAL NOT NULL,
    threshold REAL NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_drift_warnings_workspace_status
    ON scl_drift_warnings(workspace_id, status);
