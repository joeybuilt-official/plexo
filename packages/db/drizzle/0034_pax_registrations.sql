-- SPDX-License-Identifier: MIT
-- PAX (Plexo Application eXchange) — registration table
-- Stores external app registrations; tokens live in mcp_tokens with type='pax'

CREATE TABLE IF NOT EXISTS pax_registrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_name        TEXT NOT NULL,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    manifest_hash   TEXT NOT NULL,
    capabilities    TEXT[] NOT NULL DEFAULT '{}',
    token_id        UUID NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
    token_expires_at TIMESTAMPTZ,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pax_registrations_app_workspace_uq
    ON pax_registrations (workspace_id, app_name);
CREATE INDEX IF NOT EXISTS pax_registrations_workspace_idx
    ON pax_registrations (workspace_id);
CREATE INDEX IF NOT EXISTS pax_registrations_token_idx
    ON pax_registrations (token_id);

-- Rollback:
-- DROP INDEX IF EXISTS pax_registrations_token_idx;
-- DROP INDEX IF EXISTS pax_registrations_workspace_idx;
-- DROP INDEX IF EXISTS pax_registrations_app_workspace_uq;
-- DROP TABLE IF EXISTS pax_registrations;
