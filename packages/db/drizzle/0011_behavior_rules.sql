-- Phase 5: Agent Behavior Configuration System
-- behavior_rules, behavior_groups, behavior_snapshots

DO $$ BEGIN
    CREATE TYPE "public"."rule_type" AS ENUM(
        'safety_constraint',
        'operational_rule',
        'communication_style',
        'domain_knowledge',
        'persona_trait',
        'tool_preference',
        'quality_gate'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "public"."rule_source" AS ENUM(
        'platform',
        'workspace',
        'project',
        'task'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "behavior_rules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "project_id" uuid,
    "type" "rule_type" NOT NULL,
    "key" text NOT NULL,
    "label" text NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "value" jsonb NOT NULL,
    "locked" boolean NOT NULL DEFAULT false,
    "source" "rule_source" NOT NULL DEFAULT 'workspace',
    "overrides_rule_id" uuid,
    "tags" text[] NOT NULL DEFAULT '{}',
    "deleted_at" timestamp,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "behavior_groups" (
    "id" text PRIMARY KEY NOT NULL,
    "label" text NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "icon" text NOT NULL DEFAULT 'Circle',
    "rule_types" "rule_type"[] NOT NULL,
    "locked" boolean NOT NULL DEFAULT false,
    "color" text NOT NULL DEFAULT 'zinc',
    "display_order" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "behavior_snapshots" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "project_id" uuid,
    "snapshot" jsonb NOT NULL,
    "compiled_prompt" text NOT NULL DEFAULT '',
    "triggered_by" text NOT NULL DEFAULT 'manual',
    "trigger_resource_id" text,
    "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "behavior_rules_workspace_idx" ON "behavior_rules" ("workspace_id");
CREATE INDEX IF NOT EXISTS "behavior_rules_project_idx" ON "behavior_rules" ("project_id");
CREATE INDEX IF NOT EXISTS "behavior_rules_type_idx" ON "behavior_rules" ("type");
CREATE INDEX IF NOT EXISTS "behavior_rules_deleted_idx" ON "behavior_rules" ("deleted_at");
CREATE INDEX IF NOT EXISTS "behavior_snapshots_workspace_idx" ON "behavior_snapshots" ("workspace_id");
CREATE INDEX IF NOT EXISTS "behavior_snapshots_created_idx" ON "behavior_snapshots" ("created_at");
