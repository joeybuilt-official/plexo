-- Add Deepgram to connections_registry
-- Provides transcription, TTS, audio analysis, and language detection tools.

INSERT INTO connections_registry
    (id, name, description, category, logo_url, auth_type, oauth_scopes, setup_fields, tools_provided, cards_provided, is_core, doc_url, created_at)
VALUES
    (
        'deepgram',
        'Deepgram',
        'Speech-to-text, text-to-speech, and audio intelligence. Transcribe audio files, synthesize speech, detect sentiment and topics, and identify entities in recordings.',
        'voice',
        'https://deepgram.com/favicon.ico',
        'api_key',
        '[]',
        '[{"key":"api_key","label":"API Key","type":"password","required":true,"placeholder":"Token dg_...","tokenUrl":"https://console.deepgram.com/project/keys"}]',
        '["transcribe_audio","text_to_speech","analyze_audio","detect_language"]',
        '[]',
        false,
        'https://developers.deepgram.com/docs',
        now()
    )
ON CONFLICT (id) DO NOTHING;
