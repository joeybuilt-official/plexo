CREATE TABLE IF NOT EXISTS "plexo_ops_task_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id" uuid NOT NULL,
    "task_id" text NOT NULL,
    "event_type" text NOT NULL,
    "from_state" text,
    "to_state" text NOT NULL,
    "metadata" jsonb NOT NULL DEFAULT '{}',
    "recorded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plexo_ops_task_events_workspace_task_idx" ON "plexo_ops_task_events" ("workspace_id", "task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plexo_ops_task_events_event_type_idx" ON "plexo_ops_task_events" ("event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plexo_ops_task_events_recorded_at_idx" ON "plexo_ops_task_events" ("recorded_at");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "claimed_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_claimed_until_idx" ON "tasks" ("status", "claimed_until") WHERE "status" IN ('claimed', 'running');
