-- Phase 6: workspace preferences for memory-driven personalization
-- workspace_preferences stores learned preferences per workspace

CREATE TABLE IF NOT EXISTS "workspace_preferences" (
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "key" text NOT NULL,
    "value" jsonb NOT NULL DEFAULT '{}',
    "confidence" real NOT NULL DEFAULT 0.5,
    "evidence_count" integer NOT NULL DEFAULT 1,
    "last_updated" timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY ("workspace_id", "key")
);

CREATE INDEX IF NOT EXISTS "workspace_preferences_workspace_idx"
    ON "workspace_preferences" ("workspace_id");

-- agent_improvement_log tracks patterns the agent identifies in its own work
CREATE TABLE IF NOT EXISTS "agent_improvement_log" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "pattern_type" text NOT NULL,   -- 'failure_pattern' | 'success_pattern' | 'tool_preference'
    "description" text NOT NULL,
    "evidence" jsonb NOT NULL DEFAULT '[]',  -- task IDs that support this pattern
    "proposed_change" text,         -- optional: what the agent proposes to change
    "applied" boolean NOT NULL DEFAULT false,
    "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_improvement_log_workspace_idx"
    ON "agent_improvement_log" ("workspace_id");
