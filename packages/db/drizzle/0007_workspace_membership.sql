-- Migration 0007: workspace membership + invite system

DO $$ BEGIN
    CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workspace_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        member_role NOT NULL DEFAULT 'member',
    invited_by_user_id UUID REFERENCES users(id),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_idx
    ON workspace_members(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx
    ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx
    ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token               TEXT NOT NULL UNIQUE,
    invited_email       TEXT,
    role                member_role NOT NULL DEFAULT 'member',
    invited_by_user_id  UUID NOT NULL REFERENCES users(id),
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ,
    used_by_user_id     UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_token_idx
    ON workspace_invites(token);
CREATE INDEX IF NOT EXISTS workspace_invites_workspace_idx
    ON workspace_invites(workspace_id);

-- Backfill: insert workspace owner as 'owner' member for all existing workspaces
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, owner_id, 'owner'
FROM workspaces
ON CONFLICT (workspace_id, user_id) DO NOTHING;
