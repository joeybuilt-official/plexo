-- Reconcile self-host public.users casing with schema.ts + mirror.ts.
--
-- Migration 0000 created a local NextAuth-era public.users with snake_case
-- columns (email_verified TIMESTAMP, created_at TIMESTAMP, no updated_at).
-- schema.ts and packages/db/src/auth/mirror.ts both expect the Better Auth
-- camelCase shape ("emailVerified" BOOLEAN, "createdAt", "updatedAt"), the same
-- shape produced in pushd.auth."user".
--
-- On the joeybuilt deployment public.users is a postgres_fdw FOREIGN TABLE onto
-- that camelCase auth."user", so it is already correct. On a self-host deploy
-- the local table is still snake_case, so the mirror INSERT fails with
-- `column "emailVerified" does not exist` and aborts first-workspace creation.
--
-- This migration only rewrites a REAL local table (relkind 'r'). It is a no-op
-- on the FDW foreign table (relkind 'f'), leaving the joeybuilt prod topology
-- untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'users' AND c.relkind = 'r'
  ) THEN
    -- email_verified (TIMESTAMP, NextAuth-era) -> "emailVerified" (BOOLEAN)
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "emailVerified" boolean NOT NULL DEFAULT false;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email_verified'
    ) THEN
      UPDATE public.users SET "emailVerified" = ("email_verified" IS NOT NULL);
      ALTER TABLE public.users DROP COLUMN "email_verified";
    END IF;

    -- created_at -> "createdAt" (preserve existing values), normalize to timestamptz
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'created_at'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'createdAt'
    ) THEN
      ALTER TABLE public.users RENAME COLUMN "created_at" TO "createdAt";
    END IF;
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "createdAt" timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.users ALTER COLUMN "createdAt" TYPE timestamptz;

    -- "updatedAt" never existed on the legacy table
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;
