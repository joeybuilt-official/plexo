-- Migration 0013: MCP tokens table
-- Stores hashed MCP API tokens. Raw value shown once on creation.
-- SHA-256 with per-token salt. type='mcp' required for MCP transport.

CREATE TABLE IF NOT EXISTS mcp_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name        text NOT NULL,
    token_hash  text NOT NULL,          -- SHA-256(raw_token + salt)
    token_salt  text NOT NULL,          -- random 32-byte hex salt
    scopes      text[] NOT NULL DEFAULT '{}',
    type        text NOT NULL DEFAULT 'mcp',     -- always 'mcp' for now
    revoked     boolean NOT NULL DEFAULT false,
    expires_at  timestamp,              -- null = no expiry
    last_used_at timestamp,
    created_at  timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_tokens_workspace_idx ON mcp_tokens(workspace_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_hash_idx ON mcp_tokens(token_hash);
