-- Artifact Shares — shareable public links for works/artifacts.
-- Share IDs are short (12-char) text tokens used in /s/:shareId URLs.
-- Only one active (non-revoked) share per artifact enforced by partial unique index.

CREATE TABLE IF NOT EXISTS artifact_shares (
    id              TEXT PRIMARY KEY,
    artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by      TEXT NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'unlisted',
    password_hash   TEXT,
    expires_at      TIMESTAMPTZ,
    version_pin     INTEGER,
    view_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS artifact_shares_artifact_idx ON artifact_shares(artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_shares_active_uq ON artifact_shares(artifact_id) WHERE revoked_at IS NULL;
