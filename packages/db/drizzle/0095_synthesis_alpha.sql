-- Phase α — Platform Synthesis Engine
-- New: memory_themes (cluster→theme registry) + synthesis_suggestions (cross-app inbox).
-- Both reference workspaces(id) ON DELETE CASCADE. Idempotent (CREATE … IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "memory_themes" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "label" TEXT NOT NULL,
    "member_ids" UUID[] NOT NULL,
    "centroid" vector(384),
    "size" INTEGER NOT NULL,
    "growth_14d" INTEGER NOT NULL DEFAULT 0,
    "coherence" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_member_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_themes_workspace_idx" ON "memory_themes" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_themes_workspace_status_idx" ON "memory_themes" ("workspace_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "synthesis_suggestions" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "score" REAL NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "surfaced_at" TIMESTAMPTZ,
    "dismissed_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT "synthesis_suggestions_workspace_dedupe_uq" UNIQUE ("workspace_id", "dedupe_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthesis_suggestions_workspace_kind_status_score_idx"
    ON "synthesis_suggestions" ("workspace_id", "kind", "status", "score" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthesis_suggestions_workspace_status_idx"
    ON "synthesis_suggestions" ("workspace_id", "status");
