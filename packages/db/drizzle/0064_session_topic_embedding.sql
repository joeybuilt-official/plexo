-- Universal session breaks: store a running topic embedding per session turn
-- so future turns can compute cosine similarity to decide continuity.
-- Stored as jsonb (number[]) — keeps us pgvector-free and portable.

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS session_embedding jsonb;

-- Composite index that matches the session-resolver lookup pattern:
-- find the last turn for (workspace, source, session) fast, newest first.
CREATE INDEX IF NOT EXISTS conversations_ws_source_session_created_idx
    ON conversations (workspace_id, source, session_id, created_at DESC);

-- Secondary index for channelRef-based lookups in the resolver
-- (we match on channel_ref->>'chatId' in some paths).
CREATE INDEX IF NOT EXISTS conversations_ws_source_created_idx
    ON conversations (workspace_id, source, created_at DESC);
