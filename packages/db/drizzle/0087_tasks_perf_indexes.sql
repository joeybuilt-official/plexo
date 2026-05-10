CREATE INDEX IF NOT EXISTS "tasks_parent_id_idx"
    ON "tasks" ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_retry_idx"
    ON "tasks" ("status", "retry_after");
