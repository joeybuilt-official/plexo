-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Auto-connect for ALL Joeybuilt apps:
--   1. Ensure connections_registry rows exist for fylo + koforje
--      (levio, fonto, nexalog already seeded).
--   2. Backfill: for every existing user with a Plexo workspace,
--      ensure installed_connections rows exist for every Joeybuilt
--      app that has a registered profile in app_profiles.
--   3. Backfill: for every workspace, enable the bridge extension
--      row when a sideloaded bridge exists in extensions.
--
-- Idempotent — safe to re-run.

-- ── 1. Seed registry rows for fylo + koforje ──────────────────────────────
INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'fylo',
        'Fylo',
        'Receipt and document parsing via your Fylo account. Auto-connected when you use Fylo.',
        'productivity',
        'https://getfylo.com/favicon.ico',
        'none',
        '[]',
        '[]',
        '["receipt-parsing","document-extraction"]',
        '[]',
        false,
        'https://getfylo.com',
        now()
    ),
    (
        'koforje',
        'Koforje',
        'Code agents and deploy operations via your Koforje workspace. Auto-connected when you use Koforje.',
        'code',
        null,
        'none',
        '[]',
        '[]',
        '["agent.run","deploy.create","workspace.list"]',
        '[]',
        false,
        null,
        now()
    )
ON CONFLICT (id) DO NOTHING;

-- ── 2. Backfill installed_connections for every (user_workspace × joeybuilt_app) ──
-- For every workspace owned by a user that has a registered app_profile,
-- ensure an installed_connection row exists. Empty credentials — bridge
-- resolves identity via _workspaceOwnerId at runtime.
INSERT INTO installed_connections
    (workspace_id, registry_id, name, credentials, label, status, created_at)
SELECT
    w.id AS workspace_id,
    cr.id AS registry_id,
    cr.name AS name,
    '{}'::jsonb AS credentials,
    'default' AS label,
    'active'::connection_status AS status,
    now() AS created_at
FROM workspaces w
CROSS JOIN connections_registry cr
WHERE cr.id IN ('levio', 'fonto', 'nexalog', 'fylo', 'koforje')
  AND EXISTS (SELECT 1 FROM app_profiles p WHERE p.app_id = cr.id)
  AND NOT EXISTS (
      SELECT 1 FROM installed_connections ic
      WHERE ic.workspace_id = w.id
        AND ic.registry_id = cr.id
        AND ic.label = 'default'
  );
