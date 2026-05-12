-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."auth_type" AS ENUM('oauth2', 'api_key', 'webhook', 'none');--> statement-breakpoint
CREATE TYPE "public"."calibration" AS ENUM('over', 'correct', 'under');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix', 'irc', 'webchat');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'expired', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."cron_run_status" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('spec', 'features', 'decisions', 'agents', 'readme', 'custom');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('task', 'incident', 'session', 'pattern');--> statement-breakpoint
CREATE TYPE "public"."plugin_type" AS ENUM('skill', 'channel', 'tool', 'card', 'mcp-server', 'theme');--> statement-breakpoint
CREATE TYPE "public"."sprint_status" AS ENUM('planning', 'running', 'finalizing', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sprint_task_status" AS ENUM('queued', 'running', 'complete', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('telegram', 'scanner', 'github', 'cron', 'dashboard', 'api');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'claimed', 'running', 'complete', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring', 'report', 'online', 'automation');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "api_cost_tracking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"ceiling_usd" real DEFAULT 10 NOT NULL,
	"alerted_80" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"credential_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"credential_device_type" text NOT NULL,
	"credential_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "authenticators_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id"),
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "channel_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"logo_url" text,
	"auth_type" "auth_type" NOT NULL,
	"oauth_scopes" jsonb DEFAULT '[]' NOT NULL,
	"setup_fields" jsonb DEFAULT '[]' NOT NULL,
	"tools_provided" jsonb DEFAULT '[]' NOT NULL,
	"cards_provided" jsonb DEFAULT '[]' NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"doc_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"last_run_status" "cron_run_status",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"card_type" text NOT NULL,
	"position" jsonb NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installed_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"registry_id" text NOT NULL,
	"name" text NOT NULL,
	"credentials" jsonb NOT NULL,
	"scopes_granted" jsonb DEFAULT '[]' NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_verified_at" timestamp,
	"error_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"type" "plugin_type" NOT NULL,
	"manifest" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project" text NOT NULL,
	"type" "doc_type" NOT NULL,
	"filename" text NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"committed_at" timestamp,
	"commit_sha" text,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"sprint_id" text NOT NULL,
	"description" text NOT NULL,
	"scope" jsonb NOT NULL,
	"acceptance" text NOT NULL,
	"branch" text NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"status" "sprint_task_status" DEFAULT 'queued' NOT NULL,
	"handoff" jsonb,
	"worker_container_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"request" text NOT NULL,
	"status" "sprint_status" DEFAULT 'planning' NOT NULL,
	"total_tasks" integer DEFAULT 0 NOT NULL,
	"completed_tasks" integer DEFAULT 0 NOT NULL,
	"failed_tasks" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"quality_score" real,
	"total_tokens" integer,
	"cost_usd" real,
	"wall_clock_ms" integer,
	"planner_iterations" integer DEFAULT 0 NOT NULL,
	"features_completed" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "task_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"step_number" integer NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"tool_calls" jsonb,
	"outcome" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "task_type" NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"source" "task_source" NOT NULL,
	"project" text,
	"parent_id" text,
	"context" jsonb NOT NULL,
	"quality_score" real,
	"confidence_score" real,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" real,
	"prompt_version" text,
	"outcome_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" timestamp,
	"name" text,
	"image" text,
	"password_hash" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "work_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" text,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" real,
	"quality_score" real,
	"confidence_score" real,
	"calibration" "calibration",
	"deliverables" jsonb DEFAULT '[]' NOT NULL,
	"wall_clock_ms" integer,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_cost_tracking" ADD CONSTRAINT "api_cost_tracking_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_cards" ADD CONSTRAINT "dashboard_cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_cards" ADD CONSTRAINT "dashboard_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_connections" ADD CONSTRAINT "installed_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_connections" ADD CONSTRAINT "installed_connections_registry_id_connections_registry_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."connections_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_docs" ADD CONSTRAINT "project_docs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_tasks" ADD CONSTRAINT "sprint_tasks_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_ledger" ADD CONSTRAINT "work_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_ledger" ADD CONSTRAINT "work_ledger_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_cost_workspace_week_idx" ON "api_cost_tracking" USING btree ("workspace_id","week_start");--> statement-breakpoint
CREATE INDEX "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboard_cards_user_idx" ON "dashboard_cards" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "installed_connections_workspace_idx" ON "installed_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "memory_entries_workspace_type_idx" ON "memory_entries" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "plugins_workspace_idx" ON "plugins" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_docs_workspace_project_idx" ON "project_docs" USING btree ("workspace_id","project");--> statement-breakpoint
CREATE INDEX "sprint_tasks_sprint_idx" ON "sprint_tasks" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprints_workspace_idx" ON "sprints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_steps_task_idx" ON "task_steps" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_workspace_status_idx" ON "tasks" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "tasks_workspace_project_idx" ON "tasks" USING btree ("workspace_id","project");--> statement-breakpoint
CREATE INDEX "work_ledger_workspace_idx" ON "work_ledger" USING btree ("workspace_id");--> statement-breakpoint
-- pgvector: add embedding column to memory_entries (1536 dims = text-embedding-3-small)
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_embedding_idx" ON "memory_entries" USING hnsw ("embedding" vector_cosine_ops);