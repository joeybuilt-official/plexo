-- Migration 0014: Add tokenUrl to setup_fields for MCP-capable PAT integrations
-- This surfaces "Create token →" deep links in the Integrations UI so users
-- can go directly to the provider's token creation page without knowing the URL.
-- Also updates GitHub/Slack/etc. from oauth2 → api_key where PAT is the
-- preferred local-first auth method.

-- GitHub: switch to api_key (PAT) with direct token creation link
UPDATE connections_registry
SET
    auth_type = 'api_key',
    setup_fields = '[{"key":"token","label":"Personal Access Token","type":"password","placeholder":"ghp_...","required":true,"tokenUrl":"https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Plexo+Agent"}]'::jsonb,
    oauth_scopes = '[]'::jsonb
WHERE id = 'github';

-- Linear: switch to api_key with PAT link
UPDATE connections_registry
SET
    auth_type = 'api_key',
    setup_fields = '[{"key":"token","label":"Personal Access Token","type":"password","placeholder":"lin_api_...","required":true,"tokenUrl":"https://linear.app/settings/api"}]'::jsonb,
    oauth_scopes = '[]'::jsonb
WHERE id = 'linear';

-- Notion: switch to api_key with integration token link
UPDATE connections_registry
SET
    auth_type = 'api_key',
    setup_fields = '[{"key":"token","label":"Integration Token","type":"password","placeholder":"secret_...","required":true,"tokenUrl":"https://www.notion.so/my-integrations"}]'::jsonb,
    oauth_scopes = '[]'::jsonb
WHERE id = 'notion';

-- Jira: switch to api_key (API token) with direct creation link
UPDATE connections_registry
SET
    auth_type = 'api_key',
    setup_fields = '[{"key":"token","label":"API Token","type":"password","placeholder":"ATATT...","required":true,"tokenUrl":"https://id.atlassian.com/manage-profile/security/api-tokens"},{"key":"base_url","label":"Jira Base URL","type":"url","placeholder":"https://your-org.atlassian.net","required":true}]'::jsonb,
    oauth_scopes = '[]'::jsonb
WHERE id = 'jira';

-- Netlify: add tokenUrl to existing setup_fields
UPDATE connections_registry
SET
    setup_fields = '[{"key":"token","label":"Personal Access Token","type":"password","placeholder":"netlify_...","required":true,"tokenUrl":"https://app.netlify.com/user/applications/personal"}]'::jsonb
WHERE id = 'netlify';

-- Vercel: add tokenUrl to existing setup_fields
UPDATE connections_registry
SET
    setup_fields = '[{"key":"token","label":"Access Token","type":"password","placeholder":"vercel_...","required":true,"tokenUrl":"https://vercel.com/account/tokens"}]'::jsonb
WHERE id = 'vercel';

-- Slack: keep oauth2 for hosted, add bot_token PAT path for self-hosted
-- (PAT path is more practical for local Plexo instances)
UPDATE connections_registry
SET
    auth_type = 'api_key',
    setup_fields = '[{"key":"bot_token","label":"Bot Token","type":"password","placeholder":"xoxb-...","required":true,"tokenUrl":"https://api.slack.com/apps"}]'::jsonb,
    oauth_scopes = '[]'::jsonb
WHERE id = 'slack';
