-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0132  Tag: 0132_synthesis_suggestion_state
--
-- Phase 8 v2: persist synthesis-inbox actions.
--
-- Suggestions are computed on demand from the Graphiti themes-forest and are
-- NOT stored. Only the user's action on a suggestion (dismiss / snooze /
-- accept) is persisted here, keyed by the deterministic suggestion id, so
-- dismissed/snoozed items stop re-surfacing in the pending inbox after a
-- reload. Mute stays kind-level on the client (localStorage canonical).
--
-- Additive new table, IF NOT EXISTS — re-run safe, no backfill. Brand-new
-- table (not an ALTER of a queue-hot table) so applying it live before the
-- plexo-api recreate carries no claim-path risk.

CREATE TABLE IF NOT EXISTS synthesis_suggestion_state (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    suggestion_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    snoozed_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS synthesis_state_ws_sid_uidx
    ON synthesis_suggestion_state(workspace_id, suggestion_id);

CREATE INDEX IF NOT EXISTS synthesis_state_ws_status_idx
    ON synthesis_suggestion_state(workspace_id, status);
