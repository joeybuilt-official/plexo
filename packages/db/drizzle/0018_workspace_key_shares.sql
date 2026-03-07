-- Migration 0018: workspace_key_shares
-- Allows users to share AI provider keys across their workspaces without
-- copying or decrypting credentials. The key stays in the source workspace;
-- this table is a verified pointer only.

CREATE TABLE IF NOT EXISTS workspace_key_shares (
    id           TEXT PRIMARY KEY,
    source_ws_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    target_ws_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL,      -- 'openai' | 'anthropic' | 'groq' | etc.
    granted_by   UUID NOT NULL REFERENCES users(id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workspace_key_shares_unique UNIQUE (source_ws_id, target_ws_id, provider_key),
    CONSTRAINT workspace_key_shares_no_self CHECK (source_ws_id <> target_ws_id)
);

CREATE INDEX IF NOT EXISTS key_shares_source_idx ON workspace_key_shares (source_ws_id);
CREATE INDEX IF NOT EXISTS key_shares_target_idx ON workspace_key_shares (target_ws_id);
