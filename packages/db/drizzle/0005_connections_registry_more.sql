-- Migration 0005: seed 5 additional core connections
-- Run: docker exec -i docker-postgres-1 psql -U plexo -d plexo < packages/db/drizzle/0005_connections_registry_more.sql

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'vercel',
        'Vercel',
        'Deploy and manage projects, inspect deployments, and manage environment variables.',
        'hosting',
        'https://assets.vercel.com/image/upload/v1662130559/nextjs/Icon_light_background.png',
        'api_key',
        '[]',
        '[{"key":"token","label":"Access Token","type":"password","placeholder":"vercel_...","required":true}]',
        '["deploy_project","list_deployments","get_deployment","rollback","get_env_vars","set_env_var"]',
        '["deployment_status","recent_deployments"]',
        true,
        'https://vercel.com/docs/rest-api',
        now()
    ),
    (
        'netlify',
        'Netlify',
        'Trigger builds, manage sites and deployments, and inspect function logs.',
        'hosting',
        'https://www.netlify.com/v3/img/components/logomark.png',
        'api_key',
        '[]',
        '[{"key":"token","label":"Personal Access Token","type":"password","placeholder":"netlify_...","required":true}]',
        '["trigger_build","list_sites","get_deploy","list_deploys","cancel_deploy"]',
        '["build_status","recent_deploys"]',
        true,
        'https://docs.netlify.com/api/get-started/',
        now()
    ),
    (
        'google-drive',
        'Google Drive',
        'Read, search, and write files in Google Drive. Attach docs to tasks.',
        'storage',
        'https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg',
        'oauth2',
        '["https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/drive.readonly"]',
        '[]',
        '["list_files","read_file","create_file","update_file","search_files","share_file"]',
        '["recent_files","storage_usage"]',
        true,
        'https://developers.google.com/drive/api/v3/about-sdk',
        now()
    ),
    (
        'stripe',
        'Stripe',
        'Monitor payments, inspect subscriptions, and trigger refunds or payouts.',
        'finance',
        'https://stripe.com/favicon.ico',
        'api_key',
        '[]',
        '[{"key":"secret_key","label":"Secret Key","type":"password","placeholder":"sk_live_... or sk_test_...","required":true}]',
        '["list_customers","get_customer","list_payments","get_payment","create_refund","list_subscriptions"]',
        '["revenue_today","active_subscriptions"]',
        true,
        'https://stripe.com/docs/api',
        now()
    ),
    (
        'cloudflare',
        'Cloudflare',
        'Manage DNS records, purge cache, deploy Workers, and monitor zone analytics.',
        'infrastructure',
        'https://www.cloudflare.com/favicon.ico',
        'api_key',
        '[]',
        '[{"key":"api_token","label":"API Token","type":"password","placeholder":"...","required":true},{"key":"account_id","label":"Account ID","type":"text","required":true}]',
        '["list_zones","get_zone_analytics","purge_cache","list_dns_records","create_dns_record","update_dns_record","delete_dns_record","list_workers","deploy_worker"]',
        '["zone_traffic","error_rate"]',
        true,
        'https://developers.cloudflare.com/api/',
        now()
    )
ON CONFLICT (id) DO NOTHING;
