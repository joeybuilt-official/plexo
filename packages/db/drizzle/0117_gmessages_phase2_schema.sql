-- 0117_gmessages_phase2_schema.sql
-- Plexo Google Messages connector — Phase 2 schema + seed.
-- Depends on enum values added in 0116_gmessages_phase2.sql being committed.
-- ADR-0003 (schema namespace + table shapes), ADR-0002 (registry identity).

CREATE SCHEMA IF NOT EXISTS "plexo_gmessages";

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'paired_session_state' AND n.nspname = 'plexo_gmessages'
  ) THEN
    CREATE TYPE "plexo_gmessages"."paired_session_state" AS ENUM (
      'paired',
      'active',
      'refreshing',
      'expired',
      'revoked',
      'errored'
    );
  END IF;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plexo_gmessages"."paired_sessions" (
    "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "workspace_id"            uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "installed_connection_id" uuid NOT NULL REFERENCES "public"."installed_connections"("id") ON DELETE CASCADE,
    "channel_id"              uuid NOT NULL REFERENCES "public"."channels"("id") ON DELETE CASCADE,
    "state"                   "plexo_gmessages"."paired_session_state" NOT NULL DEFAULT 'paired',
    "state_changed_at"        timestamptz NOT NULL DEFAULT now(),
    "last_inbound_at"         timestamptz,
    "decode_error_count"      integer NOT NULL DEFAULT 0,
    "pair_started_at"         timestamptz,
    "paired_at"               timestamptz,
    "expired_at"              timestamptz,
    "error_detail"            text,
    "created_at"              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "paired_sessions_workspace_idx"
    ON "plexo_gmessages"."paired_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "paired_sessions_state_inbound_idx"
    ON "plexo_gmessages"."paired_sessions" ("state", "last_inbound_at");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plexo_gmessages"."message_dedupe" (
    "workspace_id"     uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "gmessages_msg_id" text NOT NULL,
    "thread_id"        text NOT NULL,
    "ingested_at"      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("workspace_id", "gmessages_msg_id")
);

CREATE INDEX IF NOT EXISTS "message_dedupe_ingested_at_idx"
    ON "plexo_gmessages"."message_dedupe" ("ingested_at");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plexo_gmessages"."rcs_feature_cache" (
    "workspace_id"        uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "thread_id"           text NOT NULL,
    "is_rcs"              boolean NOT NULL DEFAULT false,
    "supports_typing"     boolean NOT NULL DEFAULT false,
    "supports_receipts"   boolean NOT NULL DEFAULT false,
    "supports_rich_cards" boolean NOT NULL DEFAULT false,
    "refreshed_at"        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("workspace_id", "thread_id")
);

--> statement-breakpoint

INSERT INTO "public"."connections_registry"
    ("id", "name", "description", "category", "logo_url", "auth_type",
     "oauth_scopes", "setup_fields", "tools_provided", "cards_provided",
     "is_core", "is_generated", "doc_url", "created_at")
VALUES
    (
        'gmessages',
        'Google Messages',
        'Read and send SMS, MMS, and RCS messages from your phone.',
        'messaging',
        '/images/connections/gmessages.svg',
        'paired_session',
        '[]'::jsonb,
        '[]'::jsonb,
        '["gmessages__send_message", "gmessages__list_threads"]'::jsonb,
        '[]'::jsonb,
        true,
        false,
        'https://docs.plexo/connections/gmessages',
        now()
    )
ON CONFLICT ("id") DO NOTHING;
