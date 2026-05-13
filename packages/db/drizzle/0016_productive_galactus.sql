DO $block$ BEGIN EXECUTE $query$CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');$query$; EXCEPTION WHEN duplicate_object THEN NULL; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$CREATE TYPE "public"."rule_source" AS ENUM('platform', 'workspace', 'project', 'task');$query$; EXCEPTION WHEN duplicate_object THEN NULL; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$CREATE TYPE "public"."rule_type" AS ENUM('safety_constraint', 'operational_rule', 'communication_style', 'domain_knowledge', 'persona_trait', 'tool_preference', 'quality_gate');$query$; EXCEPTION WHEN duplicate_object THEN NULL; END $block$;--> statement-breakpoint
ALTER TYPE "public"."task_source" ADD VALUE IF NOT EXISTS 'extension';--> statement-breakpoint
ALTER TYPE "public"."task_source" ADD VALUE IF NOT EXISTS 'sentry';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_improvement_log" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pattern_type" text NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb DEFAULT '[]' NOT NULL,
	"proposed_change" text,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behavior_groups" (

	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'Circle' NOT NULL,
	"rule_types" "rule_type"[] NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT 'zinc' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behavior_rules" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"type" "rule_type" NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"value" jsonb NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"source" "rule_source" DEFAULT 'workspace' NOT NULL,
	"overrides_rule_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behavior_snapshots" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"snapshot" jsonb NOT NULL,
	"compiled_prompt" text DEFAULT '' NOT NULL,
	"triggered_by" text DEFAULT 'manual' NOT NULL,
	"trigger_resource_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (

	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"message" text NOT NULL,
	"reply" text,
	"error_msg" text,
	"status" text DEFAULT 'complete' NOT NULL,
	"intent" text,
	"task_id" text,
	"channel_ref" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kapsel_registry" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"publisher" text NOT NULL,
	"latest_version" text NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"deprecated" boolean DEFAULT false NOT NULL,
	"checksum" text,
	"repository_url" text,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kapsel_registry_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tokens" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_salt" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"type" text DEFAULT 'mcp' NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "models_knowledge" (

	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"context_window" integer DEFAULT 128000 NOT NULL,
	"cost_per_m_in" real NOT NULL,
	"cost_per_m_out" real NOT NULL,
	"strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reliability_score" real DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprint_logs" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sprint_id" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_invites" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" text NOT NULL,
	"invited_email" text,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"used_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_key_shares" (

	"id" text PRIMARY KEY NOT NULL,
	"source_ws_id" uuid NOT NULL,
	"target_ws_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (

	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"invited_by_user_id" uuid,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_preferences" (

	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_count" integer DEFAULT 1 NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_preferences_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "repo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections_registry" ADD COLUMN IF NOT EXISTS "is_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "installed_connections" ADD COLUMN IF NOT EXISTS "enabled_tools" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "kapsel_version" text DEFAULT '0.2.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "entry" text NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "kapsel_manifest" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN IF NOT EXISTS "cost_ceiling_usd" real;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "project_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cost_ceiling_usd" real;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "token_budget" integer;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "agent_improvement_log" ADD CONSTRAINT "agent_improvement_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "behavior_rules" ADD CONSTRAINT "behavior_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "behavior_snapshots" ADD CONSTRAINT "behavior_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "conversations" ADD CONSTRAINT "conversations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "sprint_logs" ADD CONSTRAINT "sprint_logs_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_key_shares" ADD CONSTRAINT "workspace_key_shares_source_ws_id_workspaces_id_fk" FOREIGN KEY ("source_ws_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_key_shares" ADD CONSTRAINT "workspace_key_shares_target_ws_id_workspaces_id_fk" FOREIGN KEY ("target_ws_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_key_shares" ADD CONSTRAINT "workspace_key_shares_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "workspace_preferences" ADD CONSTRAINT "workspace_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_improvement_log_workspace_idx" ON "agent_improvement_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_workspace_idx" ON "audit_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_rules_workspace_idx" ON "behavior_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_rules_project_idx" ON "behavior_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_rules_type_idx" ON "behavior_rules" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_rules_deleted_idx" ON "behavior_rules" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_snapshots_workspace_idx" ON "behavior_snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behavior_snapshots_created_idx" ON "behavior_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_workspace_idx" ON "conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_workspace_created_idx" ON "conversations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_session_idx" ON "conversations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kapsel_registry_name_idx" ON "kapsel_registry" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kapsel_registry_publisher_idx" ON "kapsel_registry" USING btree ("publisher");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kapsel_registry_deprecated_idx" ON "kapsel_registry" USING btree ("deprecated");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_workspace_idx" ON "mcp_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_hash_idx" ON "mcp_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "models_knowledge_provider_idx" ON "models_knowledge" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "models_knowledge_model_idx" ON "models_knowledge" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprint_logs_sprint_idx" ON "sprint_logs" USING btree ("sprint_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprint_logs_sprint_level_idx" ON "sprint_logs" USING btree ("sprint_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invites_token_idx" ON "workspace_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_invites_workspace_idx" ON "workspace_invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "key_shares_source_idx" ON "workspace_key_shares" USING btree ("source_ws_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "key_shares_target_idx" ON "workspace_key_shares" USING btree ("target_ws_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "key_shares_unique_idx" ON "workspace_key_shares" USING btree ("source_ws_id","target_ws_id","provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_idx" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_workspace_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_preferences_workspace_idx" ON "workspace_preferences" USING btree ("workspace_id");--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_sprints_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "installed_connections_workspace_registry_uq" ON "installed_connections" USING btree ("workspace_id","registry_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugins_workspace_name_uq" ON "plugins" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_project_id_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "plugins" DROP COLUMN IF EXISTS "manifest";--> statement-breakpoint
ALTER TABLE "public"."plugins" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."plugin_type";--> statement-breakpoint
DO $block$ BEGIN EXECUTE $query$CREATE TYPE "public"."plugin_type" AS ENUM('agent', 'skill', 'channel', 'tool', 'mcp-server');$query$; EXCEPTION WHEN duplicate_object THEN NULL; END $block$;--> statement-breakpoint
ALTER TABLE "public"."plugins" ALTER COLUMN "type" SET DATA TYPE "public"."plugin_type" USING "type"::"public"."plugin_type";