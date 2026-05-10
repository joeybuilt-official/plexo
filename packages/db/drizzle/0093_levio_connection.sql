-- Add Levio as an installable connection in the registry.
-- Auth type 'none' because the connection is auto-installed by Levio when a user
-- connects their account — no manual credential entry required.

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'levio',
        'Levio',
        'Read emails and calendar events from your Levio account. Auto-connected when you use Levio.',
        'pm',
        'https://mylevio.com/favicon.ico',
        'none',
        '[]',
        '[]',
        '["list_emails","list_events","create_task"]',
        '[]',
        false,
        'https://mylevio.com',
        now()
    )
ON CONFLICT (id) DO NOTHING;
