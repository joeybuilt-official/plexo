-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Provider instances: multi-instance, capability-aware provider configuration.
-- Coexists with the existing workspaces.settings.vault/arbiter JSONB during
-- the Intelligence page transition. Phase 7 completes the migration.
-- Lightweight — new table, no existing data modified.

CREATE TABLE IF NOT EXISTS provider_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    endpoint_url TEXT,
    -- Credentials: encrypted API key (same AES-256-GCM as vault)
    encrypted_key TEXT,
    -- Discovered capabilities (auto-populated, never user-edited)
    capabilities JSONB NOT NULL DEFAULT '{
        "supportsChat": false,
        "supportsEmbeddings": false,
        "chatModels": [],
        "embeddingModels": [],
        "discoveryError": null
    }'::jsonb,
    preference_order INTEGER NOT NULL DEFAULT 0,
    managed BOOLEAN NOT NULL DEFAULT false,
    enabled BOOLEAN NOT NULL DEFAULT true,
    -- Model selection
    selected_model TEXT,
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_discovered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_provider_instances_workspace
    ON provider_instances(workspace_id, preference_order);

CREATE INDEX IF NOT EXISTS idx_provider_instances_type
    ON provider_instances(workspace_id, provider_type);

-- Ensure only one managed provider per type per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_instances_managed_unique
    ON provider_instances(workspace_id, provider_type) WHERE managed = true;
