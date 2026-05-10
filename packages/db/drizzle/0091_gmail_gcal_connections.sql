-- Add Gmail-only and Google Calendar-only connections to the registry.
-- Users can connect individual Google services rather than the full Workspace bundle.
-- All three Google providers (gmail, google-calendar, google-drive) and google-workspace
-- share the same OAuth app and a single redirect URI:
--   https://getplexo.com/api/oauth/google/callback

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'gmail',
        'Gmail',
        'Read and send email via your Gmail account.',
        'comms',
        'https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg',
        'oauth2',
        '["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile"]',
        '[]',
        '["list_emails","read_email","send_email"]',
        '[]',
        true,
        'https://developers.google.com/gmail/api',
        now()
    ),
    (
        'google-calendar',
        'Google Calendar',
        'List, create, update, and delete events in your Google Calendar.',
        'pm',
        'https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg',
        'oauth2',
        '["https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile"]',
        '[]',
        '["list_events","create_event","update_event","delete_event"]',
        '[]',
        true,
        'https://developers.google.com/calendar/api/guides/overview',
        now()
    )
ON CONFLICT (id) DO NOTHING;
