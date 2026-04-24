-- FUN-042: Add indexes to session_logs for common query patterns
CREATE INDEX IF NOT EXISTS session_logs_session_id_idx ON session_logs (session_id);
CREATE INDEX IF NOT EXISTS session_logs_user_created_idx ON session_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS session_logs_created_at_idx ON session_logs (created_at);

-- FUN-043: Add composite index to work_ledger for workspace+time queries
CREATE INDEX IF NOT EXISTS work_ledger_ws_created_idx ON work_ledger (workspace_id, completed_at);
