-- Cross-app token handoff table (lives in the shared auth schema)
-- Allows a user authenticated in one Joeybuilt app to obtain a short-lived
-- single-use token that a target app can exchange for a local session.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.cross_app_tokens (
    token       TEXT        PRIMARY KEY,
    user_id     UUID        NOT NULL,
    source_app  TEXT        NOT NULL,
    target_app  TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cross_app_tokens_user_id_idx ON auth.cross_app_tokens (user_id);
CREATE INDEX IF NOT EXISTS cross_app_tokens_expires_at_idx ON auth.cross_app_tokens (expires_at);
