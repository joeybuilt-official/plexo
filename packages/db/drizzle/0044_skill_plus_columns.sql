-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Skill+ support: add source discriminator and SKILL.md storage columns
-- to the extensions table. Existing Fabric extensions default to 'fabric'.

ALTER TABLE extensions ADD COLUMN source TEXT NOT NULL DEFAULT 'fabric';
ALTER TABLE extensions ADD COLUMN skill_path TEXT;
ALTER TABLE extensions ADD COLUMN skill_content TEXT;
ALTER TABLE extensions ADD COLUMN skill_frontmatter JSONB;
