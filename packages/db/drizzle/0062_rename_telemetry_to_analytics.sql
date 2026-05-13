-- Rename telemetry tables to analytics for consistent naming across the stack.
-- Command Center and Command Engine already use "analytics" terminology.

-- Rename plexo_ops_telemetry -> plexo_ops_analytics
ALTER TABLE IF EXISTS plexo_ops_telemetry RENAME TO plexo_ops_analytics;
ALTER INDEX IF EXISTS plexo_ops_telemetry_event_idx RENAME TO plexo_ops_analytics_event_idx;
ALTER INDEX IF EXISTS plexo_ops_telemetry_created_idx RENAME TO plexo_ops_analytics_created_idx;

-- Rename telemetry_digest_failures -> analytics_digest_failures
ALTER TABLE IF EXISTS telemetry_digest_failures RENAME TO analytics_digest_failures;
