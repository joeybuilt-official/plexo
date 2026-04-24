-- Add enabled_tools column to installed_connections
-- Stores which tools from toolsProvided are enabled (null = all enabled by default)
ALTER TABLE installed_connections
    ADD COLUMN IF NOT EXISTS enabled_tools jsonb DEFAULT NULL;
