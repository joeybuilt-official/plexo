-- 0118_concept_graph_phase_1.sql
-- ADR 0009 — concept graph layer replacing SCL/MindsetObject.
-- Three tables atop existing memory_entries + pgvector substrate.
-- Idempotent: safe to re-run.

-- pgvector extension already enabled by an earlier migration; included
-- here as a no-op safety check.
CREATE EXTENSION IF NOT EXISTS vector;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."concept_nodes" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id"  uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "label"         text NOT NULL,
    "type"          text,
    "embedding"     vector(384),
    "created_at"    timestamptz NOT NULL DEFAULT now(),
    "updated_at"    timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "concept_nodes_workspace_label_idx"
    ON "public"."concept_nodes" ("workspace_id", "label");

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "concept_nodes_workspace_label_uq"
    ON "public"."concept_nodes" ("workspace_id", "label");

--> statement-breakpoint

-- HNSW vector index on embedding for cosine similarity in edge inference.
-- Mirrors the memory_embeddings HNSW pattern from migration 0102.
CREATE INDEX IF NOT EXISTS "concept_nodes_embedding_hnsw_idx"
    ON "public"."concept_nodes" USING hnsw ("embedding" vector_cosine_ops);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."concept_edges" (
    "workspace_id"  uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "src_node_id"   uuid NOT NULL REFERENCES "public"."concept_nodes"("id") ON DELETE CASCADE,
    "dst_node_id"   uuid NOT NULL REFERENCES "public"."concept_nodes"("id") ON DELETE CASCADE,
    "relation"      text NOT NULL DEFAULT 'related',
    "weight"        real NOT NULL DEFAULT 1.0,
    "created_at"    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("workspace_id", "src_node_id", "dst_node_id", "relation")
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "concept_edges_workspace_src_idx"
    ON "public"."concept_edges" ("workspace_id", "src_node_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "concept_edges_workspace_dst_idx"
    ON "public"."concept_edges" ("workspace_id", "dst_node_id");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."concept_membership" (
    "workspace_id"     uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "memory_entry_id"  uuid NOT NULL REFERENCES "public"."memory_entries"("id") ON DELETE CASCADE,
    "concept_node_id"  uuid NOT NULL REFERENCES "public"."concept_nodes"("id") ON DELETE CASCADE,
    "weight"           real NOT NULL DEFAULT 1.0,
    "created_at"       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("workspace_id", "memory_entry_id", "concept_node_id")
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "concept_membership_workspace_node_idx"
    ON "public"."concept_membership" ("workspace_id", "concept_node_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "concept_membership_workspace_entry_idx"
    ON "public"."concept_membership" ("workspace_id", "memory_entry_id");
