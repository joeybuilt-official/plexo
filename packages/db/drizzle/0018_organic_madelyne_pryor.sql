CREATE TYPE "public"."sprint_file_event_type" AS ENUM('lock', 'conflict', 'change', 'build_error', 'ts_error');--> statement-breakpoint
CREATE TYPE "public"."sprint_pattern_type" AS ENUM('conflict_hotspot', 'complexity_signal', 'recurring_error');--> statement-breakpoint
CREATE TABLE "sprint_file_events" (
	"id" text PRIMARY KEY NOT NULL,
	"sprint_id" text NOT NULL,
	"repo" text NOT NULL,
	"event_type" "sprint_file_event_type" NOT NULL,
	"file_path" text NOT NULL,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"sprint_id" text NOT NULL,
	"task_id" text,
	"summary" text NOT NULL,
	"files_changed" jsonb DEFAULT '[]' NOT NULL,
	"concerns" jsonb DEFAULT '[]' NOT NULL,
	"suggestions" jsonb DEFAULT '[]' NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"suspicious" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"pattern_type" "sprint_pattern_type" NOT NULL,
	"subject" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"avg_duration_ms" integer,
	"avg_quality" real,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint_file_events" ADD CONSTRAINT "sprint_file_events_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_handoffs" ADD CONSTRAINT "sprint_handoffs_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_handoffs" ADD CONSTRAINT "sprint_handoffs_task_id_sprint_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sprint_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sprint_file_events_sprint_idx" ON "sprint_file_events" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_file_events_repo_path_idx" ON "sprint_file_events" USING btree ("repo","file_path");--> statement-breakpoint
CREATE INDEX "sprint_handoffs_sprint_idx" ON "sprint_handoffs" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_patterns_repo_idx" ON "sprint_patterns" USING btree ("repo");--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_patterns_repo_type_subject_idx" ON "sprint_patterns" USING btree ("repo","pattern_type","subject");