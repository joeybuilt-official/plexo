-- Add google-workspace (Gmail + Calendar + Tasks) to the connections registry.
-- Separate from google-drive since Levio and other productivity apps need
-- mail/calendar scopes, not file storage scopes.

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'google-workspace',
        'Google Workspace',
        'Gmail, Google Calendar, and Google Tasks — unified inbox, calendar events, and task management for productivity apps.',
        'productivity',
        'https://www.gstatic.com/images/branding/product/2x/google_g_512dp.png',
        'oauth2',
        '["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/tasks.readonly","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile"]',
        '[]',
        '["read_email","send_email","list_events","create_event","update_event","delete_event","list_tasks","create_task"]',
        '["gmail_unread","calendar_today","tasks_due"]',
        true,
        'https://developers.google.com/gmail/api',
        now()
    )
ON CONFLICT (id) DO NOTHING;
