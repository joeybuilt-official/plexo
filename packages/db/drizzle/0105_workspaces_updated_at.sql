-- Phase H Stage 2 (post-audit): repair schema-vs-DDL drift on workspaces.
-- Item 2 in ops/coreaudit/07-DEFERRED.md. Adding the column lets workspace
-- creation succeed when callers (or future schema declarations) include
-- updated_at in the insert payload. Idempotent — IF NOT EXISTS guards envs
-- that already added it ad-hoc. DEFAULT now() backfills existing rows.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
