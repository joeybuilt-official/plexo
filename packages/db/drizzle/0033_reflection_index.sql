-- Reflection feature: add 'reflection' to rule_source enum and unique index on behavior_rules.
-- Required by packages/agent/src/behavior/reflect.ts for ON CONFLICT upserts.

-- Add 'reflection' to the rule_source enum
ALTER TYPE "rule_source" ADD VALUE IF NOT EXISTS 'reflection';

-- Partial unique index: one active rule per (workspace, key)
CREATE UNIQUE INDEX IF NOT EXISTS "behavior_rules_ws_key"
  ON "behavior_rules" ("workspace_id", "key")
  WHERE "deleted_at" IS NULL;
