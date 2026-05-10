-- Federation runtime: node status fields, node_events, user_app_authorizations
-- Extends the nodes table with connection-tracking fields and adds two new tables.

-- ── nodes: add runtime fields ─────────────────────────────────────────────────

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sync_token   text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'active';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_ping_at timestamptz;

-- ── node_events ───────────────────────────────────────────────────────────────
-- Inbound events from federated nodes or local app profiles.
-- source_node_did is the DID of the emitting node (or 'self' for local).

CREATE TABLE IF NOT EXISTS node_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_node_did text NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL DEFAULT '{}',
    workspace_id    uuid REFERENCES workspaces(id) ON DELETE SET NULL,
    processed       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_events_source_idx      ON node_events(source_node_did);
CREATE INDEX IF NOT EXISTS node_events_type_idx        ON node_events(event_type);
CREATE INDEX IF NOT EXISTS node_events_workspace_idx   ON node_events(workspace_id);
CREATE INDEX IF NOT EXISTS node_events_processed_idx   ON node_events(processed, created_at DESC);

-- ── user_app_authorizations ───────────────────────────────────────────────────
-- Per-user, per-workspace grants for a registered app profile.
-- An authorization grants the app the right to act on behalf of this user
-- within this workspace for the listed scopes.

CREATE TABLE IF NOT EXISTS user_app_authorizations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id       text NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    scopes       text[] NOT NULL DEFAULT '{}',
    granted_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    UNIQUE(user_id, app_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS user_app_auth_user_idx      ON user_app_authorizations(user_id);
CREATE INDEX IF NOT EXISTS user_app_auth_workspace_idx ON user_app_authorizations(workspace_id);
CREATE INDEX IF NOT EXISTS user_app_auth_app_idx       ON user_app_authorizations(app_id);
