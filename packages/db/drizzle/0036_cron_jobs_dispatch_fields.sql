-- Scheduled Dispatch: add dispatch fields to cron_jobs
-- task_type: queue task type pushed when this job fires
-- task_context: arbitrary context object passed to queue.push()
-- next_run_at: pre-computed next fire time for efficient polling
ALTER TABLE "cron_jobs"
    ADD COLUMN "task_type" text NOT NULL DEFAULT 'general',
    ADD COLUMN "task_context" jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN "next_run_at" timestamptz;

CREATE INDEX "cron_jobs_next_run_idx" ON "cron_jobs" ("next_run_at") WHERE "enabled" = true;
