ALTER TABLE "cron_jobs" ALTER COLUMN "schedule" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT cron_jobs_fire_mechanism_check
  CHECK ((schedule IS NOT NULL) OR (next_run_at IS NOT NULL));
