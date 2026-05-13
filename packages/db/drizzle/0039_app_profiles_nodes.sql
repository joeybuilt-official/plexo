-- App Profiles: external Joeybuilt apps registered with this Core instance
CREATE TABLE IF NOT EXISTS app_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          text NOT NULL UNIQUE,
    schema_namespace text NOT NULL,
    display_name    text NOT NULL,
    event_contracts jsonb NOT NULL DEFAULT '[]',
    registered_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz
);

-- Nodes: Plexo instances in a federation mesh
CREATE TABLE IF NOT EXISTS nodes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    did             text NOT NULL UNIQUE,
    display_name    text,
    url             text,
    is_self         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Node Trust: per-scope trust edges between nodes
CREATE TABLE IF NOT EXISTS node_trust (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_node_id       uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    remote_node_id      uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    memory_sync         boolean NOT NULL DEFAULT false,
    agent_routing       boolean NOT NULL DEFAULT false,
    event_propagation   boolean NOT NULL DEFAULT false,
    established_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    UNIQUE(local_node_id, remote_node_id)
);

CREATE INDEX IF NOT EXISTS node_trust_local_idx ON node_trust(local_node_id);
CREATE INDEX IF NOT EXISTS node_trust_remote_idx ON node_trust(remote_node_id);

-- Self-record: this instance's node entry.
-- Uses PLEXO_INSTANCE_ID as the DID component. The migration runner does not
-- have access to env vars, so we use a DO block with a fallback UUID.
DO $$
DECLARE
    self_did text;
BEGIN
    -- Build a deterministic DID from the instance. If no env var is available
    -- at migration time, we use a placeholder that the API will update on boot.
    self_did := 'did:plexo:' || coalesce(current_setting('app.plexo_instance_id', true), gen_random_uuid()::text);

    INSERT INTO nodes (did, display_name, is_self)
    VALUES (self_did, 'Self', true)
    ON CONFLICT (did) DO NOTHING;
END $$;
