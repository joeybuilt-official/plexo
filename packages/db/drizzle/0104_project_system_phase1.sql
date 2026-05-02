-- Project System Phase 1: durable execution-engine columns.
--
-- Adds:
--   tasks.plan jsonb                 — persisted planner output (resumability)
--   tasks.wall_clock_limit_sec int   — per-task wall-clock budget (override sweeper default)
--   tasks.failed_at timestamptz      — terminal-fail timestamp (split from completed_at)
--   tasks.failure_reason text        — machine-readable failure reason (split from outcomeSummary)
--   task_steps.state enum            — pending|running|completed|failed|skipped
--   task_steps.step_type enum        — tool_call|confirmation|verification|llm_generation
--   task_steps.step_spec jsonb       — frozen planner step spec (resume-from-step)
--   task_steps.attempts int          — per-step retry count
--   task_steps.error text            — step-level error (distinct from free-form outcome)
--   task_steps.started_at timestamptz, task_steps.completed_at timestamptz
--   index task_steps_task_state_idx on (task_id, state)
--
-- All additions are nullable / defaulted so the migration is backward-compatible
-- with existing rows and existing call sites.

DO $$ BEGIN
    CREATE TYPE "task_step_state" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
    CREATE TYPE "task_step_type" AS ENUM ('tool_call', 'confirmation', 'verification', 'llm_generation');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "plan" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "wall_clock_limit_sec" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint

ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "state" "task_step_state" NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "step_type" "task_step_type";
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "step_spec" jsonb;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "error" text;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill: existing terminal steps inherit a sensible state. Steps with
-- isTerminal=true are marked completed; everything else stays 'pending' (the
-- default) since we have no reliable signal otherwise.
UPDATE "task_steps" SET "state" = 'completed' WHERE "is_terminal" = true AND "state" = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_steps_task_state_idx" ON "task_steps" ("task_id", "state");
