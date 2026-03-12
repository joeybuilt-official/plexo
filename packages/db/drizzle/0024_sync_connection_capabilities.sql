-- Sync connections_registry tools_provided to match the capability manifest.
-- Fixes mismatches between what the planner sees and what the UI shows.
-- Also normalises google_drive → google-drive (matches MCP_BINDINGS key).

-- ── Slack: add post_to_channel, list_channels, read_messages ────────────────
UPDATE connections_registry
SET tools_provided = '["send_message", "post_to_channel", "list_channels", "read_messages"]'::jsonb
WHERE id = 'slack';

-- ── Discord: add send_message, read_messages ────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["send_message", "read_messages", "queue_task"]'::jsonb
WHERE id = 'discord';

-- ── Telegram: add receive_task ──────────────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["send_message", "receive_task"]'::jsonb
WHERE id = 'telegram';

-- ── Notion: sync with manifest (create_page, update_page, search_pages, read_page, append_blocks)
UPDATE connections_registry
SET tools_provided = '["create_page", "update_page", "search_pages", "read_page", "append_blocks"]'::jsonb
WHERE id = 'notion';

-- ── Linear: add list_issues, search_issues ──────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["create_issue", "update_issue", "add_comment", "list_issues", "search_issues"]'::jsonb
WHERE id = 'linear';

-- ── Jira: add list_issues, search_issues ────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["create_issue", "update_issue", "add_comment", "list_issues", "search_issues"]'::jsonb
WHERE id = 'jira';

-- ── PagerDuty: already correct (trigger_incident, resolve_incident, add_note)
-- no change needed

-- ── Datadog: already correct (query_metrics, query_logs, create_event)
-- no change needed

-- ── Google Drive: normalise ID from google_drive → google-drive ─────────────
-- Only runs if the old ID still exists (fresh installs use 0005 which may already have google-drive)
UPDATE connections_registry
SET id = 'google-drive',
    tools_provided = '["file_upload", "create_doc", "read_doc", "search_files"]'::jsonb
WHERE id = 'google_drive';

-- If google-drive already exists (from 0005), just update tools
UPDATE connections_registry
SET tools_provided = '["file_upload", "create_doc", "read_doc", "search_files"]'::jsonb
WHERE id = 'google-drive';

-- ── OpenAI: add embed_text ──────────────────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["embed_text", "image_generation", "vision", "transcription"]'::jsonb
WHERE id = 'openai';

-- ── Vercel: add trigger_deploy ──────────────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["list_deployments", "get_deployment_status", "trigger_deploy"]'::jsonb
WHERE id = 'vercel';

-- ── Netlify: add trigger_deploy ─────────────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["list_deployments", "get_deployment_status", "trigger_deploy"]'::jsonb
WHERE id = 'netlify';

-- ── Stripe: add list_customers, list_subscriptions ──────────────────────────
UPDATE connections_registry
SET tools_provided = '["read_payments", "read_revenue", "list_customers", "list_subscriptions"]'::jsonb
WHERE id = 'stripe';

-- ── Cloudflare: add update_dns ──────────────────────────────────────────────
UPDATE connections_registry
SET tools_provided = '["purge_cache", "list_dns", "update_dns"]'::jsonb
WHERE id = 'cloudflare';

-- ── GitLab: insert if not exists (has MCP binding but no seed entry) ────────
INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'gitlab',
        'GitLab',
        'Full read/write access to repositories, branches, files, issues, and merge requests.',
        'code',
        'https://about.gitlab.com/images/press/press-kit-icon.svg',
        'api_key',
        '[]',
        '[{"key":"api_key","label":"Personal Access Token","type":"password"},{"key":"base_url","label":"GitLab URL (optional, for self-hosted)","type":"text"}]',
        '["read_code", "write_code", "create_file", "push_commits", "create_branch", "delete_branch", "create_mr", "merge_mr", "list_issues", "create_issue", "update_issue", "search_code"]',
        '["gitlab_activity"]',
        false,
        'https://docs.gitlab.com/ee/api/',
        now()
    )
ON CONFLICT (id) DO UPDATE SET
    tools_provided = EXCLUDED.tools_provided,
    description = EXCLUDED.description;
