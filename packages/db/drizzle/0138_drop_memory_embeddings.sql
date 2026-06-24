-- ADR-0044: retire the dead `memory_embeddings` table.
-- It held 0 rows on prod and had zero code references (only the drizzle schema
-- declared it). The live recall vector is memory_entries.embedding, read by the
-- cosine HNSW search in packages/agent/src/memory/store.ts — that column is NOT
-- touched here. Idempotent; cascades the entry_id FK + indexes.
--
-- Applied manually to the prod `plexo` DB (this deploy's migrate flow is
-- journal-driven and journal-maintenance stopped at 0129; 0130+ are applied via
-- psql, same as this one).
DROP TABLE IF EXISTS memory_embeddings CASCADE;
