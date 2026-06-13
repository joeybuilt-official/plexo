-- A3: per-app service keys. Replaces the shared PLEXO_SERVICE_KEY by mirroring
-- the mcp_tokens hashing pattern (SHA-256 + per-token salt). Issued and revoked
-- by the admin UI; consumed by service-key-auth middleware in dual-accept phase.
CREATE TABLE IF NOT EXISTS "app_service_keys" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "app_id" text NOT NULL,
    "name" text NOT NULL,
    "token_hash" text NOT NULL,
    "token_salt" text NOT NULL,
    "revoked" boolean DEFAULT false NOT NULL,
    "expires_at" timestamp,
    "last_used_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "created_by" text
);

CREATE INDEX IF NOT EXISTS "app_service_keys_app_id_idx" ON "app_service_keys" ("app_id");
CREATE INDEX IF NOT EXISTS "app_service_keys_hash_idx" ON "app_service_keys" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "app_service_keys_app_id_name_unique" ON "app_service_keys" ("app_id", "name");
