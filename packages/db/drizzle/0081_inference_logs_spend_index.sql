CREATE INDEX IF NOT EXISTS inference_logs_ws_created_success_idx
    ON inference_logs (workspace_id, created_at)
    WHERE success = true;
