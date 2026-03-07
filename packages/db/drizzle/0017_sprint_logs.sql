-- 0017_sprint_logs.sql
-- Real-time activity log for sprint/project execution.
-- Written by the sprint runner on every meaningful event.
-- Read by the Control Room UI via GET /api/v1/sprints/:id/logs.

CREATE TABLE IF NOT EXISTS sprint_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    sprint_id   TEXT        NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    level       TEXT        NOT NULL DEFAULT 'info',  -- info | warn | error
    event       TEXT        NOT NULL,                 -- planning_start | task_queued | wave_start | task_running | task_complete | task_failed | sprint_complete | sprint_failed | conflict_detected | pr_created | budget_check
    message     TEXT        NOT NULL,
    metadata    JSONB       NOT NULL DEFAULT '{}',    -- task_id, wave, branch, cost, etc.
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sprint_logs_sprint_idx ON sprint_logs(sprint_id, created_at ASC);
CREATE INDEX IF NOT EXISTS sprint_logs_sprint_level_idx ON sprint_logs(sprint_id, level);
