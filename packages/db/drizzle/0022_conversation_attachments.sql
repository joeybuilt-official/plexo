-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC

-- Add attachments column to conversations table
ALTER TABLE "conversations" ADD COLUMN "attachments" JSONB DEFAULT '[]' NOT NULL;
