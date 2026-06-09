-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0134  Tag: 0134_workspace_app_grants
--
-- Connection & Profile Standard (ADR 0001 §3) — per-(app×workspace) capability
-- grant. Default-deny: the absence of an active 'granted' row means the app gets
-- nothing in that workspace. An app's connect() requestedProfile is advisory;
-- this table is authoritative. Only the operator may widen a grant.
--
CREATE TABLE IF NOT EXISTS workspace_app_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id text NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    allowed_connectors text[] NOT NULL DEFAULT '{}',
    capabilities text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'granted',  -- 'granted' | 'pending' | 'revoked'
    granted_by text,
    granted_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_app_grants_uq ON workspace_app_grants (app_id, workspace_id);
CREATE INDEX IF NOT EXISTS workspace_app_grants_ws_idx ON workspace_app_grants (workspace_id);
CREATE INDEX IF NOT EXISTS workspace_app_grants_app_idx ON workspace_app_grants (app_id);
