CREATE TYPE "public"."rsi_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."rsi_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "rsi_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"anomaly_type" text NOT NULL,
	"hypothesis" text NOT NULL,
	"proposed_change" jsonb DEFAULT '{}' NOT NULL,
	"risk" "rsi_risk" DEFAULT 'medium' NOT NULL,
	"status" "rsi_status" DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rsi_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"task_id" text,
	"is_shadow" boolean DEFAULT true NOT NULL,
	"baseline_quality" real,
	"shadow_quality" real,
	"token_delta" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rsi_proposals" ADD CONSTRAINT "rsi_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsi_test_results" ADD CONSTRAINT "rsi_test_results_proposal_id_rsi_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."rsi_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsi_test_results" ADD CONSTRAINT "rsi_test_results_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rsi_proposals_workspace_idx" ON "rsi_proposals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rsi_proposals_status_idx" ON "rsi_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rsi_test_results_proposal_idx" ON "rsi_test_results" USING btree ("proposal_id");