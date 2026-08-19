-- SPDX-License-Identifier: MIT
-- Idx: 0142  Tag: 0142_conversation_overrides
--
-- DD-5: per-conversation model + system-prompt overrides for the web chat UI.
-- The operator can pick a model and tune the system prompt inline while
-- coding; both are persisted on the conversation row and read back by the
-- chat path. See apps/api/src/routes/chat.ts + chat-overrides.ts.
--
-- Additive, nullable, no backfill — re-run safe. Empty/null = use the
-- compiled default behavior (current behavior pre-DD-5).

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_override TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS system_prompt_override TEXT;