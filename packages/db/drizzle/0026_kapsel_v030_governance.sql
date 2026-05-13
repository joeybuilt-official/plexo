-- Kapsel v0.3.0: Extension Audit Trail (§18), Standing Approvals (§23), UserSelf (§20)

-- §18 — Immutable Kapsel extension/agent audit trail
-- Separate from the general audit_log which tracks user/workspace-level actions.
-- This tracks extension-level actions: function invocations, memory access, channel sends, etc.
CREATE TABLE IF NOT EXISTS kapsel_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    extension_id TEXT NOT NULL,
    agent_id TEXT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    model_context JSONB,
    escalation_outcome TEXT CHECK (escalation_outcome IS NULL OR escalation_outcome IN ('approve', 'deny', 'approve-and-remember')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kapsel_audit_workspace_time ON kapsel_audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kapsel_audit_extension ON kapsel_audit_log(extension_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kapsel_audit_agent ON kapsel_audit_log(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

-- §23 — Standing approval rules (user-owned, created via "Approve & Remember")
CREATE TABLE IF NOT EXISTS standing_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    action_pattern TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_standing_approvals_workspace ON standing_approvals(workspace_id);

-- §20 — Persistent UserSelf graph
CREATE TABLE IF NOT EXISTS user_self (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    identity JSONB NOT NULL DEFAULT '{}',
    preferences JSONB NOT NULL DEFAULT '{}',
    relationships TEXT[] NOT NULL DEFAULT '{}',
    contexts JSONB NOT NULL DEFAULT '{}',
    communication_style JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
