-- SPDX-License-Identifier: AGPL-3.0-only
-- Stabilization eval tables: ground truth for SCL evaluation + eval results storage.
-- Both tables ship with every Plexo instance. Ground truth data is populated
-- by the test harness; eval_results can be written by any operator's eval tooling.

CREATE TABLE IF NOT EXISTS scl_eval_ground_truth (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    stimulus TEXT NOT NULL,
    expected_attractor_ids TEXT[] NOT NULL DEFAULT '{}',
    expected_resolution TEXT NOT NULL DEFAULT 'L1',
    expected_promoted BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scl_eval_gt_workspace
    ON scl_eval_ground_truth(workspace_id);

CREATE TABLE IF NOT EXISTS eval_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    eval_type TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_results_type
    ON eval_results(eval_type, metric_name);
CREATE INDEX IF NOT EXISTS idx_eval_results_created
    ON eval_results(created_at);
