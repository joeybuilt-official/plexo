-- Add Coolify, Sentry, PostHog, and OVHcloud connections to the registry
-- for Command Center integration.

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'coolify',
        'Coolify',
        'Self-hosted PaaS — manage deployments, services, and infrastructure from Coolify.',
        'infrastructure',
        'https://coolify.io/favicon.png',
        'api_key',
        '[]',
        '[{"key":"token","label":"API Token","type":"password","required":true},{"key":"base_url","label":"Coolify URL","type":"url","required":true,"placeholder":"https://coolify.example.com"}]',
        '["list_services","get_service","list_deployments","redeploy_service","get_service_logs"]',
        '["deployment_status"]',
        true,
        'https://coolify.io/docs/api-reference',
        now()
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'sentry',
        'Sentry',
        'Error tracking and performance monitoring — view projects, issues, and resolve errors.',
        'observability',
        'https://sentry.io/_assets/favicon.ico',
        'api_key',
        '[]',
        '[{"key":"auth_token","label":"Auth Token","type":"password","required":true},{"key":"organization","label":"Organization Slug","type":"text","required":true}]',
        '["list_projects","list_issues","resolve_issue","assign_issue","get_issue_details"]',
        '["error_summary"]',
        true,
        'https://docs.sentry.io/api/',
        now()
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'posthog',
        'PostHog',
        'Product analytics — insights, feature flags, and user engagement metrics.',
        'analytics',
        'https://posthog.com/brand/posthog-icon.svg',
        'api_key',
        '[]',
        '[{"key":"api_key","label":"Personal API Key","type":"password","required":true},{"key":"project_id","label":"Project ID","type":"text","required":true},{"key":"api_host","label":"API Host","type":"url","required":false,"placeholder":"https://app.posthog.com"}]',
        '["list_insights","list_feature_flags","toggle_feature_flag","get_trends"]',
        '["analytics_summary"]',
        true,
        'https://posthog.com/docs/api',
        now()
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'ovhcloud',
        'OVHcloud',
        'Cloud infrastructure — monitor dedicated servers, VPS instances, and resource usage.',
        'infrastructure',
        'https://www.ovhcloud.com/favicon.ico',
        'api_key',
        '[]',
        '[{"key":"application_key","label":"Application Key","type":"text","required":true},{"key":"application_secret","label":"Application Secret","type":"password","required":true},{"key":"consumer_key","label":"Consumer Key","type":"password","required":true},{"key":"endpoint","label":"API Endpoint","type":"text","required":false,"placeholder":"ovh-eu"}]',
        '["list_servers","get_server_status","reboot_server"]',
        '["server_health"]',
        true,
        'https://api.ovh.com/',
        now()
    )
ON CONFLICT (id) DO NOTHING;
