-- Migration 0008: audit_log table + workspace rate-limit column

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id),
    action          TEXT NOT NULL,
    resource        TEXT NOT NULL,
    resource_id     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    ip              TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_workspace_idx ON audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx    ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_created_idx   ON audit_log(created_at DESC);
