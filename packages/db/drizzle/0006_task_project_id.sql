-- Migration 0006: Add project_id FK on tasks → sprints
-- Tasks optionally belong to a project (sprint). ON DELETE SET NULL
-- preserves task history when a sprint is deleted.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS project_id text
        REFERENCES sprints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id);

-- Backfill: link existing tasks to their sprint via sprint_tasks join.
-- Only fills where exactly one sprint owns the task (defensive for any dups).
-- UPDATE tasks t
-- SET project_id = st.sprint_id
-- FROM sprint_tasks st
-- WHERE st.task_id = t.id
--   AND t.project_id IS NULL
--   AND (
--       SELECT COUNT(*) FROM sprint_tasks st2 WHERE st2.task_id = t.id
--   ) = 1;
