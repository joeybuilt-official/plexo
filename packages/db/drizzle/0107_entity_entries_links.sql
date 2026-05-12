-- Phase J reconciliation: schema.ts declared entity_entries + entity_links
-- (§16, entities.* PAX capability) but no migration ever created them.
-- This was a Phase A schema-vs-DDL drift carry-over surfaced by the new
-- check-drift gate. IF NOT EXISTS guards make this idempotent across envs
-- that may have been hand-bootstrapped.

CREATE TABLE IF NOT EXISTS entity_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    external_id TEXT,
    name TEXT NOT NULL,
    aliases JSONB DEFAULT '[]'::jsonb,
    data JSONB DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_entries_workspace_idx ON entity_entries(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_entries_type_idx ON entity_entries(workspace_id, type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_entries_external_idx ON entity_entries(workspace_id, type, external_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS entity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    source_id UUID NOT NULL REFERENCES entity_entries(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES entity_entries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'related_to',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_links_source_idx ON entity_links(source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_links_target_idx ON entity_links(target_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entity_links_unique_idx ON entity_links(source_id, target_id, kind);
