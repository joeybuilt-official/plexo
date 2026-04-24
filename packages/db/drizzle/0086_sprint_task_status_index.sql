CREATE INDEX IF NOT EXISTS "sprint_tasks_sprint_status_idx"
    ON "sprint_tasks" ("sprint_id", "status");
