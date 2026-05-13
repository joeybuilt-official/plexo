-- Migration: Replace Auth.js with Supabase Auth
-- Phase 2 of Plexo SaaS integration
--
-- Changes:
-- 1. Remove Auth.js tables (accounts, sessions, verification_tokens, authenticators)
-- 2. Remove password_hash from users (passwords now in Supabase)
-- 3. Add is_super_admin to users (for Command Center cross-workspace access)
-- 4. Remove defaultRandom() from users.id (now set explicitly from Supabase UUID)

-- Drop Auth.js tables (order matters for FK constraints)
DROP TABLE IF EXISTS "authenticators" CASCADE;
DROP TABLE IF EXISTS "sessions" CASCADE;
DROP TABLE IF EXISTS "verification_tokens" CASCADE;
DROP TABLE IF EXISTS "accounts" CASCADE;

-- Remove password_hash column from users
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";

-- Add super-admin flag
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_super_admin" boolean NOT NULL DEFAULT false;

-- Remove the defaultRandom() default on users.id so IDs come from Supabase
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;
