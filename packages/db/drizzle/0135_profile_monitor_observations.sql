-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0135  Tag: 0135_profile_monitor_observations
--
-- Connection & Profile Standard (ADR 0001 §3) — monitor-mode observations.
-- When PROFILE_ENFORCEMENT_MODE=monitor, the tool-load bridges record (instead of
-- only logging) each connector/capability an app's effective profile WOULD have
-- excluded. This durable record survives container recreates and powers the App
-- Grants UI, so the operator can seed grants from real coverage gaps before
-- switching to hard enforce. One row per (workspace, app, kind, token); re-seeing
-- a gap bumps observed_count + last_seen_at.
--
CREATE TABLE IF NOT EXISTS profile_monitor_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_id text NOT NULL,
    kind text NOT NULL,            -- 'connector' | 'capability'
    token text NOT NULL,           -- connector registryId, or capability token
    ext_name text,                 -- extension a capability came from (nullable)
    observed_count integer NOT NULL DEFAULT 1,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_monitor_obs_uq
    ON profile_monitor_observations (workspace_id, app_id, kind, token);
CREATE INDEX IF NOT EXISTS profile_monitor_obs_ws_idx
    ON profile_monitor_observations (workspace_id);
