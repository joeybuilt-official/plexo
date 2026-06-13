-- ============================================================================
-- DRAFT — DO NOT APPLY. Expand phase only. Contract (drop old col + rename)
-- is a SEPARATE gated step after code reads the _numeric columns. Apply
-- requires a prod snapshot + operator sign-off.
-- ============================================================================
--
-- A6: money columns stored as `real` (float4) lose precision on compare/
-- accumulate. This EXPAND migration ADDs a parallel numeric(18,6) column for
-- each money column and backfills via a copy+cast. It is reversible and
-- non-destructive: no old column is dropped, renamed, or altered. Both the
-- old `real` and the new `_numeric` column coexist until the code cutover.
--
-- numeric(18,6): 6 decimal places covers per-token sub-cent pricing
-- (e.g. cost_per_m_in / cost_per_m_out). 18 total digits is ample headroom.
--
-- NOT INCLUDED HERE (separate gated contract phase, after code cutover):
--   - DROP of the old `real` column
--   - RENAME of `_numeric` -> original column name
--   - schema.ts real(...) -> numeric(...) change
-- ============================================================================

-- ── tasks ───────────────────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN cost_usd_numeric numeric(18,6);
UPDATE tasks SET cost_usd_numeric = cost_usd::numeric;

ALTER TABLE tasks ADD COLUMN cost_ceiling_usd_numeric numeric(18,6);
UPDATE tasks SET cost_ceiling_usd_numeric = cost_ceiling_usd::numeric;

-- ── sprints (audited as "projectMetadata"; SQL table is `sprints`) ───────────
ALTER TABLE sprints ADD COLUMN cost_usd_numeric numeric(18,6);
UPDATE sprints SET cost_usd_numeric = cost_usd::numeric;

ALTER TABLE sprints ADD COLUMN cost_ceiling_usd_numeric numeric(18,6);
UPDATE sprints SET cost_ceiling_usd_numeric = cost_ceiling_usd::numeric;

-- ── api_cost_tracking ────────────────────────────────────────────────────────
-- Source columns are NOT NULL with defaults (cost_usd default 0,
-- ceiling_usd default 10). Backfill leaves NOT NULL/default to the contract
-- phase; here the _numeric column is nullable until cutover.
ALTER TABLE api_cost_tracking ADD COLUMN cost_usd_numeric numeric(18,6);
UPDATE api_cost_tracking SET cost_usd_numeric = cost_usd::numeric;

ALTER TABLE api_cost_tracking ADD COLUMN ceiling_usd_numeric numeric(18,6);
UPDATE api_cost_tracking SET ceiling_usd_numeric = ceiling_usd::numeric;

-- ── models_knowledge (per-token pricing — sub-cent precision critical) ───────
ALTER TABLE models_knowledge ADD COLUMN cost_per_m_in_numeric numeric(18,6);
UPDATE models_knowledge SET cost_per_m_in_numeric = cost_per_m_in::numeric;

ALTER TABLE models_knowledge ADD COLUMN cost_per_m_out_numeric numeric(18,6);
UPDATE models_knowledge SET cost_per_m_out_numeric = cost_per_m_out::numeric;

-- ── work_ledger ──────────────────────────────────────────────────────────────
ALTER TABLE work_ledger ADD COLUMN cost_usd_numeric numeric(18,6);
UPDATE work_ledger SET cost_usd_numeric = cost_usd::numeric;

-- ============================================================================
-- END EXPAND PHASE. Contract phase is intentionally omitted (gated).
-- ============================================================================
