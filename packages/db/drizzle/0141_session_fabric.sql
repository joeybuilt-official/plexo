-- 0141_session_fabric.sql
-- Session Fabric — Phase 1a schema (contract mirror).
-- Hand-authored: `drizzle-kit generate` requires a TTY for its enum resolver in
-- this environment. Column-for-column equivalent to packages/db/src/session-fabric-schema.ts
-- and the @plexo/session-fabric Zod contract. AUTHORED ONLY — not applied.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
    CREATE TYPE "public"."session_status" AS ENUM ('active', 'paused', 'blocked', 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'policy_tier') THEN
    CREATE TYPE "public"."policy_tier" AS ENUM ('observe', 'steer', 'drive');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_event_kind') THEN
    CREATE TYPE "public"."session_event_kind" AS ENUM ('message', 'tool_call', 'tool_result', 'plan', 'approval_request', 'approval_decision', 'status', 'handoff', 'usage', 'outcome');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_actor_type') THEN
    CREATE TYPE "public"."session_actor_type" AS ENUM ('user', 'agent', 'runner', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_outcome_kind') THEN
    CREATE TYPE "public"."session_outcome_kind" AS ENUM ('test', 'ci', 'gate', 'human', 'judge');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_participant_kind') THEN
    CREATE TYPE "public"."session_participant_kind" AS ENUM ('head', 'runner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_participant_surface') THEN
    CREATE TYPE "public"."session_participant_surface" AS ENUM ('cli', 'mobile', 'desktop', 'channel');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_participant_role') THEN
    CREATE TYPE "public"."session_participant_role" AS ENUM ('observer', 'steerer', 'driver');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'runner_backend') THEN
    CREATE TYPE "public"."runner_backend" AS ENUM ('agent-sdk', 'generic');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'runner_status') THEN
    CREATE TYPE "public"."runner_status" AS ENUM ('online', 'draining', 'offline');
  END IF;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sessions" (
    "id"           text PRIMARY KEY NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "title"        text,
    "status"       "public"."session_status" NOT NULL DEFAULT 'active',
    "driver_id"    text,
    "policy_tier"  "public"."policy_tier" NOT NULL DEFAULT 'steer',
    -- created_by is NOT FK'd: prod public.users is an FDW foreign table
    -- (-> pushd.auth.user) and Postgres cannot reference a foreign table.
    "created_by"   uuid NOT NULL,
    "created_at"   timestamptz NOT NULL DEFAULT now(),
    "updated_at"   timestamptz NOT NULL DEFAULT now(),
    "closed_at"    timestamptz
);

CREATE INDEX IF NOT EXISTS "sessions_workspace_status_idx" ON "sessions" USING btree ("workspace_id", "status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "session_events" (
    "id"             bigserial PRIMARY KEY NOT NULL,
    "session_id"     text NOT NULL REFERENCES "public"."sessions"("id") ON DELETE CASCADE,
    "seq"            integer NOT NULL,
    "schema_version" integer NOT NULL DEFAULT 1,
    "kind"           "public"."session_event_kind" NOT NULL,
    "actor_type"     "public"."session_actor_type" NOT NULL,
    "actor_id"       text,
    "payload"        jsonb NOT NULL,
    "model"          text,
    "provider"       text,
    "tokens_in"      integer,
    "tokens_out"     integer,
    "cost_usd"       real,
    "outcome_kind"   "public"."session_outcome_kind",
    "reward"         real,
    "reward_source"  text,
    "provenance"     jsonb,
    "outcome_of_seq" integer,
    "resolved_at"    timestamptz,
    "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_seq_uq" ON "session_events" USING btree ("session_id", "seq");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "session_participants" (
    "session_id"     text NOT NULL REFERENCES "public"."sessions"("id") ON DELETE CASCADE,
    "participant_id" text NOT NULL,
    "kind"           "public"."session_participant_kind" NOT NULL,
    "surface"        "public"."session_participant_surface",
    "capabilities"   jsonb NOT NULL,
    "role"           "public"."session_participant_role" NOT NULL DEFAULT 'observer',
    "last_heartbeat" timestamptz NOT NULL DEFAULT now(),
    "joined_at"      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "session_participants_session_id_participant_id_pk" PRIMARY KEY ("session_id", "participant_id")
);

CREATE INDEX IF NOT EXISTS "session_participants_heartbeat_idx" ON "session_participants" USING btree ("last_heartbeat");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "runners" (
    "id"             text PRIMARY KEY NOT NULL,
    "workspace_id"   uuid REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
    "backend"        "public"."runner_backend" NOT NULL,
    "capabilities"   jsonb NOT NULL,
    "status"         "public"."runner_status" NOT NULL DEFAULT 'online',
    "last_heartbeat" timestamptz NOT NULL DEFAULT now(),
    "registered_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "runners_status_idx" ON "runners" USING btree ("status");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "leases" (
    "session_id"    text PRIMARY KEY NOT NULL REFERENCES "public"."sessions"("id") ON DELETE CASCADE,
    "runner_id"     text NOT NULL REFERENCES "public"."runners"("id") ON DELETE CASCADE,
    "claimed_at"    timestamptz NOT NULL DEFAULT now(),
    "claimed_until" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "leases_runner_idx" ON "leases" USING btree ("runner_id");

--> statement-breakpoint

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "session_id" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_session_id_sessions_id_fk') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_session_id_sessions_id_fk"
      FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id");
  END IF;
END $$;
