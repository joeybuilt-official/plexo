-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add workspace_id, mindset_object, updated_at to scl_concept_graphs.
-- Add index on domain_region.

ALTER TABLE scl_concept_graphs ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE scl_concept_graphs ADD COLUMN IF NOT EXISTS mindset_object JSONB;
ALTER TABLE scl_concept_graphs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_scl_concept_graphs_domain ON scl_concept_graphs(domain_region);
CREATE INDEX IF NOT EXISTS idx_scl_concept_graphs_workspace ON scl_concept_graphs(workspace_id);
