-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add per-capability preference ordering to provider_instances.
-- Each provider can have a different priority in the Thinking vs Memory
-- sections of the Intelligence page. Lightweight — two new columns,
-- default to existing preference_order value.

ALTER TABLE provider_instances
    ADD COLUMN IF NOT EXISTS chat_preference_order INTEGER,
    ADD COLUMN IF NOT EXISTS embedding_preference_order INTEGER;

-- Default to the existing global preference_order
UPDATE provider_instances
SET chat_preference_order = preference_order,
    embedding_preference_order = preference_order
WHERE chat_preference_order IS NULL;
