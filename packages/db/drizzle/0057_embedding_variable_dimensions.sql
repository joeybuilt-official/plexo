-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Remove fixed 1536-dimension constraint from memory_entries.embedding.
-- The EmbeddingRouter supports multiple providers with different dimensions
-- (OpenAI: 1536, Google: 768, Snowflake/Cohere/Mistral/Voyage: 1024).
-- Each workspace uses one provider consistently, but the column must accept any.
-- Lightweight — type cast only, no data rewrite.

ALTER TABLE memory_entries ALTER COLUMN embedding TYPE vector USING embedding::vector;
