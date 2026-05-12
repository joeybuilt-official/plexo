-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Phase 7 — Per-agent audit trails + identity overrides.
--
-- Adds extension identity columns to extension_audit_log so the audit
-- trail can distinguish "tool called by the workspace primary" from
-- "tool called by @plexo/research-agent v1.0.0" without having to
-- round-trip back through the extensions table.
--
-- Columns:
--   extension_name    — display name frozen at call time (falls back to extensionId)
--   extension_version — semver frozen at call time (nullable; unknown for system)
--
-- Also adds a workspace/extension GIN-less btree composite to support
-- "last N actions this extension performed" previews.

ALTER TABLE extension_audit_log
    ADD COLUMN IF NOT EXISTS extension_name text;

ALTER TABLE extension_audit_log
    ADD COLUMN IF NOT EXISTS extension_version text;

-- Fast lookup: "show me the last N entries for this extension in this workspace"
CREATE INDEX IF NOT EXISTS ext_audit_workspace_extension_time_idx
    ON extension_audit_log (workspace_id, extension_id, created_at DESC);
