-- 0116_gmessages_phase2.sql
-- Plexo Google Messages connector — Phase 2 enum extensions only.
-- ADR-0003. Splits the new enum values from the registry seed because Postgres
-- requires new enum values to be committed before they can be referenced in
-- the same transaction (`new enum values must be committed before they can be
-- used`). 0117_gmessages_phase2_schema.sql lands the schema + seed.

ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'gmessages';
--> statement-breakpoint
ALTER TYPE "auth_type"    ADD VALUE IF NOT EXISTS 'paired_session';
--> statement-breakpoint
ALTER TYPE "task_source"  ADD VALUE IF NOT EXISTS 'gmessages';
