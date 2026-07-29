-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Migration 0070 — Backfill workspace_members for pre-existing workspace owners.
--
-- Background: Phase 1 hardening added `workspace_members` + the
-- `ensureWorkspaceAccess` middleware, but the new owner-enroll insert in
-- POST /api/v1/workspaces only runs for workspaces created AFTER that code
-- shipped. Any workspace created before Phase 1 had an owner_id set on the
-- workspaces row but no corresponding row in workspace_members — so every
-- workspace-scoped endpoint returned 403 FORBIDDEN "You are not a member of
-- this workspace" for the actual owner.
--
-- This backfill is idempotent (ON CONFLICT DO NOTHING) and safe to replay.
-- Every workspace with a non-null owner_id gets an `owner` membership row
-- pinned to the workspace creation time.
--
-- Verification after apply:
--   SELECT w.id, w.name, u.email, wm.role
--     FROM workspaces w
--     LEFT JOIN users u ON u.id = w.owner_id
--     LEFT JOIN workspace_members wm
--       ON wm.workspace_id = w.id AND wm.user_id = w.owner_id;
-- Every row should show `role = owner`.

INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
SELECT id, owner_id, 'owner'::member_role, created_at
FROM workspaces
WHERE owner_id IS NOT NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;
