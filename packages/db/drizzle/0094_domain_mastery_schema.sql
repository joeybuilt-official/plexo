-- Domain Mastery Phase 2: Additive schema changes (ADR-001, ADR-002)
-- All columns nullable, all tables new. No breaking changes.

-- ADR-001: domain_tag on work_ledger
ALTER TABLE work_ledger ADD COLUMN IF NOT EXISTS domain_tag TEXT;
CREATE INDEX IF NOT EXISTS work_ledger_domain_tag_idx ON work_ledger (workspace_id, domain_tag) WHERE domain_tag IS NOT NULL;

-- ADR-001: domain_tag on rsi_proposals
ALTER TABLE rsi_proposals ADD COLUMN IF NOT EXISTS domain_tag TEXT;

-- ADR-001: context_hash on work_ledger (for credit assignment, ADR-003)
ALTER TABLE work_ledger ADD COLUMN IF NOT EXISTS context_hash TEXT;

-- ADR-001: context_rule_keys on work_ledger (invertible credit assignment, Panel 2)
ALTER TABLE work_ledger ADD COLUMN IF NOT EXISTS context_rule_keys JSONB;

-- ADR-002: learning_events table
CREATE TABLE IF NOT EXISTS learning_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    domain_tag TEXT,
    event_type TEXT NOT NULL,
    source_surface TEXT NOT NULL,
    source_ref TEXT,
    quality_context REAL,
    context_hash TEXT,
    shareable BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS learning_events_workspace_idx ON learning_events (workspace_id);
CREATE INDEX IF NOT EXISTS learning_events_workspace_domain_idx ON learning_events (workspace_id, domain_tag) WHERE domain_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_context_hash_idx ON learning_events (context_hash) WHERE context_hash IS NOT NULL;

-- Domain metrics aggregate table (refreshed by cron)
CREATE TABLE IF NOT EXISTS plexo_ops_domain_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    domain_tag TEXT NOT NULL,
    period_start DATE NOT NULL,
    avg_quality REAL,
    task_count INTEGER NOT NULL DEFAULT 0,
    learning_event_count INTEGER NOT NULL DEFAULT 0,
    quality_delta REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_metrics_ws_domain_period_uq
    ON plexo_ops_domain_metrics (workspace_id, domain_tag, period_start);
CREATE INDEX IF NOT EXISTS domain_metrics_workspace_idx
    ON plexo_ops_domain_metrics (workspace_id);

-- ADR-004: shareable flag on behavior_rules (Panel 7 privacy rec)
ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS shareable BOOLEAN NOT NULL DEFAULT false;
