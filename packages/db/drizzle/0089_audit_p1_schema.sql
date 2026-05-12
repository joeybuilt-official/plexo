-- AUDIT-P1 schema fixes
-- D-01: session_logs.created_at — add timezone awareness
-- D-02: memory_entries.content — full-text search GIN index
-- D-05: installed_connections.registry_id — standalone FK index
-- D-08: tasks.parent_id — add ON DELETE SET NULL to prevent orphaned children

--> statement-breakpoint
ALTER TABLE "session_logs" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_content_fts_idx"
  ON "memory_entries" USING gin(to_tsvector('english', "content"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installed_connections_registry_idx"
  ON "installed_connections" ("registry_id");
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_parent_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;
