-- Phase 10: Memory namespacing.
-- Adds a `namespace` column to every memory-related table so multiple agents
-- sharing one workspace can keep their memory slices isolated, while still
-- supporting cross-namespace reads (e.g. the special 'shared' namespace that
-- any agent can read but only its owner writes).
--
-- NO DATA LOSS — additive only. Every existing row defaults to 'default',
-- which is also the fallback used by read/write paths that don't pass an
-- explicit namespace. This preserves byte-for-byte backward compatibility
-- with pre-phase-10 agents.

ALTER TABLE memory_entries
    ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS memory_entries_workspace_namespace_idx
    ON memory_entries(workspace_id, namespace);

CREATE INDEX IF NOT EXISTS memory_entries_workspace_namespace_type_idx
    ON memory_entries(workspace_id, namespace, type);

ALTER TABLE workspace_preferences
    ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'default';

-- workspace_preferences primary key is (workspace_id, key). Namespacing
-- preferences means the effective uniqueness is (workspace_id, namespace,
-- key). We do NOT drop the existing PK (that would be destructive and
-- would break the FDW/foreign-key story). Instead we add a compound index
-- so reads scoped to (workspace_id, namespace) stay fast.
CREATE INDEX IF NOT EXISTS workspace_preferences_workspace_namespace_idx
    ON workspace_preferences(workspace_id, namespace);
