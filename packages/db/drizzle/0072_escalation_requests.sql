-- Phase 8 — Escalation Runtime
-- Persists per-invocation human-in-the-loop approval requests. A row is
-- created every time the executor pauses on a risky tool call. The row's
-- lifecycle is pending → approved | rejected | timeout; decided_at and
-- decided_by are null until the user acts (or the sweeper ages it out).
CREATE TABLE IF NOT EXISTS escalation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  agent_id text,
  tool_name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  expires_at timestamptz NOT NULL,
  decision_note text
);

CREATE INDEX IF NOT EXISTS escalation_requests_workspace_status_idx
  ON escalation_requests(workspace_id, status);

CREATE INDEX IF NOT EXISTS escalation_requests_session_idx
  ON escalation_requests(session_id);

CREATE INDEX IF NOT EXISTS escalation_requests_expires_idx
  ON escalation_requests(expires_at) WHERE status = 'pending';
