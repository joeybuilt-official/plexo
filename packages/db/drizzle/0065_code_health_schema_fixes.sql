-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Phase 10 — Code Health
-- Schema hygiene fixes surfaced by the Phase 7 DR drill:
--   1. `models_knowledge` had duplicate IDs (pre-PK historical rows).
--      pg_dump restore fails because INSERTs are replayed before the
--      PK is added, so the PK constraint is rejected on restore.
--   2. `memory_entries.embedding` was an untyped `vector` column
--      (relaxed in 0057 to allow multiple providers). pgvector
--      rejects HNSW index creation on an untyped vector, so the index
--      fails to replay on restore. Live content is uniformly 384-dim
--      (the `plexo-embed-v1` model), so we can safely pin the type.
--
-- All statements are idempotent / no-op on a clean DB.

-- 1. Dedupe models_knowledge (keep one row per id, arbitrary winner).
DELETE FROM models_knowledge a
    USING models_knowledge b
    WHERE a.id = b.id
      AND a.ctid < b.ctid;

-- 2. Type memory_entries.embedding as vector(384) and rebuild HNSW.
--    Works on both directions: if already typed, the ALTER is a no-op;
--    if untyped, the USING cast forces the dimension.
DROP INDEX IF EXISTS memory_entries_embedding_idx;

ALTER TABLE memory_entries
    ALTER COLUMN embedding TYPE vector(384)
    USING embedding::vector(384);

CREATE INDEX IF NOT EXISTS memory_entries_embedding_idx
    ON memory_entries
    USING hnsw (embedding vector_cosine_ops);
