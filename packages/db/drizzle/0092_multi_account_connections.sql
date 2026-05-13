-- Add label column to installed_connections for multi-account support.
-- Allows multiple connections with the same registryId per workspace (e.g., two Google accounts).
-- Existing rows get label = 'default'.

ALTER TABLE "installed_connections" ADD COLUMN "label" text NOT NULL DEFAULT 'default';

-- Replace the old per-registryId unique constraint with a per-(registryId, label) constraint.
DROP INDEX IF EXISTS "installed_connections_workspace_registry_uq";
CREATE UNIQUE INDEX "installed_connections_workspace_registry_label_uq"
    ON "installed_connections" ("workspace_id", "registry_id", "label");
