-- 0084: Drop unique index on workspaces.owner_id to allow multi-workspace per user.
-- The constraint was added in 0080 to prevent duplicate "Personal" workspaces from
-- SSR races, but it blocks intentional creation of additional workspaces.

DROP INDEX IF EXISTS workspaces_owner_id_unique_idx;
