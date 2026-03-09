-- 0020_conversation_channel_ref.sql
-- Adds channel_ref JSONB to conversations for bidirectional channel routing.
-- Nullable — existing rows unaffected.
-- Shape: { channel: 'telegram'|'slack'|'discord', channelId: string, chatId: string }

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_ref JSONB DEFAULT NULL;

-- Index for looking up sessions originating from a given channel
CREATE INDEX IF NOT EXISTS conversations_channel_ref_idx ON conversations USING gin(channel_ref) WHERE channel_ref IS NOT NULL;

-- Ensure session_id index exists (may have been missed in 0016)
CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_session_source_idx ON conversations(workspace_id, session_id, created_at DESC) WHERE session_id IS NOT NULL;
