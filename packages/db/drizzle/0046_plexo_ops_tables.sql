-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Plexo-native observability tables. Replaces PostHog/Sentry for
-- error tracking and anonymous telemetry.

CREATE TABLE IF NOT EXISTS plexo_ops_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app TEXT NOT NULL DEFAULT 'plexo',
    fingerprint TEXT NOT NULL,
    message TEXT NOT NULL,
    stack_trace TEXT,
    context JSONB DEFAULT '{}'::jsonb,
    deploy_id TEXT,
    resolved_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    occurrence_count INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS plexo_ops_errors_fingerprint_idx ON plexo_ops_errors (fingerprint);
CREATE INDEX IF NOT EXISTS plexo_ops_errors_app_idx ON plexo_ops_errors (app);

CREATE TABLE IF NOT EXISTS plexo_ops_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app TEXT NOT NULL DEFAULT 'plexo',
    event_name TEXT NOT NULL,
    properties JSONB DEFAULT '{}'::jsonb,
    instance_uuid TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plexo_ops_telemetry_event_idx ON plexo_ops_telemetry (event_name);
CREATE INDEX IF NOT EXISTS plexo_ops_telemetry_created_idx ON plexo_ops_telemetry (created_at);
