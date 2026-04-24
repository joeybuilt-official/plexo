-- Phase 1 of the intelligence overhaul.
-- Per-instance embedding-model selection metadata for the Intelligence
-- → Embeddings UI surface. Lets a workspace pin one model per provider
-- (e.g. OpenAI = text-embedding-3-large vs text-embedding-3-small) and
-- record the dimension count returned at last successful resolution
-- so the re-embed flow can warn on dimension mismatches.
--
-- NO DATA LOSS — additive migration, IF NOT EXISTS guards on every column.

ALTER TABLE provider_instances
    ADD COLUMN IF NOT EXISTS embedding_model text;

ALTER TABLE provider_instances
    ADD COLUMN IF NOT EXISTS embedding_dimensions integer;

ALTER TABLE provider_instances
    ADD COLUMN IF NOT EXISTS embedding_last_used_at timestamptz;
