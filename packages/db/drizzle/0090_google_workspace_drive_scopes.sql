-- Update google-workspace registry entry to add Drive scopes and tools.
-- Also updates description and category to reflect all three Google services.

UPDATE connections_registry
SET
    name        = 'Google (Gmail + Calendar + Drive)',
    description = 'Gmail, Google Calendar, and Google Drive — read and send email, manage calendar events, and access Drive files from one connection.',
    category    = 'productivity',
    oauth_scopes = '["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/tasks.readonly","https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile"]',
    tools_provided = '["list_emails","read_email","send_email","list_events","create_event","update_event","delete_event","search_drive","get_file","create_file"]'
WHERE id = 'google-workspace';
