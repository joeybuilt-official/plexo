-- Kapsel v0.3.0: Prompt Library (§7.6) and Context Layer (§7.7)
-- Adds tables for extension-contributed prompt templates and context blocks.

-- New enum for artifact priority levels
CREATE TYPE "public"."artifact_priority" AS ENUM('low', 'normal', 'high', 'critical');

-- Extend rule_source to include extension-contributed rules
ALTER TYPE "public"."rule_source" ADD VALUE IF NOT EXISTS 'extension';

-- Extension prompt templates (disabled by default, user enables per-workspace)
CREATE TABLE IF NOT EXISTS "extension_prompts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "extension_name" text NOT NULL,
    "prompt_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "template" text NOT NULL,
    "variables" jsonb NOT NULL DEFAULT '[]',
    "variable_defaults" jsonb NOT NULL DEFAULT '{}',
    "tags" text[] NOT NULL DEFAULT '{}',
    "version" text NOT NULL,
    "priority" "artifact_priority" NOT NULL DEFAULT 'normal',
    "dependencies" text[] NOT NULL DEFAULT '{}',
    "enabled" boolean NOT NULL DEFAULT false,
    "deleted_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ext_prompts_workspace_idx" ON "extension_prompts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ext_prompts_extension_idx" ON "extension_prompts" ("extension_name");
CREATE INDEX IF NOT EXISTS "ext_prompts_enabled_idx" ON "extension_prompts" ("workspace_id", "enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_prompts_unique_idx" ON "extension_prompts" ("workspace_id", "extension_name", "prompt_id");

-- Extension context blocks (injected into system prompt at execution time)
CREATE TABLE IF NOT EXISTS "extension_contexts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "extension_name" text NOT NULL,
    "context_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "content" text NOT NULL,
    "content_type" text NOT NULL DEFAULT 'text/plain',
    "priority" "artifact_priority" NOT NULL DEFAULT 'normal',
    "ttl" integer,
    "tags" text[] NOT NULL DEFAULT '{}',
    "estimated_tokens" integer,
    "last_refreshed_at" timestamp DEFAULT now() NOT NULL,
    "enabled" boolean NOT NULL DEFAULT true,
    "deleted_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ext_contexts_workspace_idx" ON "extension_contexts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ext_contexts_extension_idx" ON "extension_contexts" ("extension_name");
CREATE INDEX IF NOT EXISTS "ext_contexts_priority_idx" ON "extension_contexts" ("workspace_id", "priority");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_contexts_unique_idx" ON "extension_contexts" ("workspace_id", "extension_name", "context_id");
