-- Idempotent re-application of app_profiles, nodes, and node_trust tables.
-- Migration 0039 was tracked in __drizzle_migrations on first deploy but the
-- DDL did not execute (prior Coolify deploy applied the hash before SQL ran).
-- This migration guarantees the tables exist on all production instances.

CREATE TABLE IF NOT EXISTS app_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          text NOT NULL UNIQUE,
    schema_namespace text NOT NULL,
    display_name    text NOT NULL,
    event_contracts jsonb NOT NULL DEFAULT '[]',
    registered_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz
);

CREATE TABLE IF NOT EXISTS nodes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    did             text NOT NULL UNIQUE,
    display_name    text,
    url             text,
    is_self         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

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
