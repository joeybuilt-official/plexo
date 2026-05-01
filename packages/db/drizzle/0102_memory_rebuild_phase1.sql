-- Phase 1: Memory Rebuild — extend memory_entries, create memory_embeddings
--> statement-breakpoint
ALTER TABLE "memory_entries"
    ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "fact_type" text,
    ADD COLUMN IF NOT EXISTS "subject" text,
    ADD COLUMN IF NOT EXISTS "predicate" text,
    ADD COLUMN IF NOT EXISTS "object" text,
    ADD COLUMN IF NOT EXISTS "domain" text,
    ADD COLUMN IF NOT EXISTS "scope_level" text,
    ADD COLUMN IF NOT EXISTS "app_id" text,
    ADD COLUMN IF NOT EXISTS "source_text" text,
    ADD COLUMN IF NOT EXISTS "source" text,
    ADD COLUMN IF NOT EXISTS "superseded_by" uuid REFERENCES "memory_entries"("id") ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "valid_from" timestamptz,
    ADD COLUMN IF NOT EXISTS "invalid_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "retrieval_count" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "last_retrieved_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "confidence" real NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS "is_anchored" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_user_id_idx" ON "memory_entries" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_scope_level_idx" ON "memory_entries" ("scope_level");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_fact_type_idx" ON "memory_entries" ("fact_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_confidence_idx" ON "memory_entries" ("confidence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_retrieval_count_idx" ON "memory_entries" ("retrieval_count");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_superseded_by_idx" ON "memory_entries" ("superseded_by");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_embeddings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "entry_id" uuid NOT NULL UNIQUE REFERENCES "memory_entries"("id") ON DELETE CASCADE,
    "embedding" vector(384),
    "model" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_embeddings_entry_id_idx" ON "memory_embeddings" ("entry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_hnsw_idx"
    ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
