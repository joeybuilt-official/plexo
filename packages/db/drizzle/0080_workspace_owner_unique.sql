-- 0080: Add unique index on workspaces.owner_id to prevent duplicate personal workspaces.
-- Before adding the constraint, deduplicate any existing rows: keep the oldest workspace
-- per owner_id and delete the rest.

DELETE FROM workspaces
WHERE id NOT IN (
    SELECT DISTINCT ON (owner_id) id
    FROM workspaces
    ORDER BY owner_id, created_at ASC
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_id_unique_idx ON workspaces (owner_id);
