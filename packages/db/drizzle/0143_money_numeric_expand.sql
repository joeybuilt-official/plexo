-- SPDX-License-Identifier: MIT
-- Idx: 0143  Tag: 0143_money_numeric_expand
--
-- Repo-provisioning fix for the A6 money-precision EXPAND columns. schema.ts
-- has declared the nine `*_numeric` money columns since the A6 work, and
-- apps/api/src/agent-loop.ts writes them, but their only DDL lived in
-- drizzle/DRAFT_money_numeric.sql — a draft that is never applied (the
-- orphaned-SQL runner skips DRAFT_*). Drizzle names every schema column in an
-- INSERT, so on any database built from this repo every write to tasks /
-- sprints / work_ledger / api_cost_tracking failed with
-- `column "cost_usd_numeric" of relation "tasks" does not exist`.
--
-- These columns were hand-applied to the joeybuilt deployment already, so
-- ADD COLUMN IF NOT EXISTS makes this a literal no-op there and provisions a
-- fresh/e2e database correctly. Un-journaled by repo convention (0130+ hand-SQL
-- stays out of meta/_journal.json); applied by scripts/apply-orphaned-sql.ts.
--
-- numeric(18,6), nullable, no default — exactly what schema.ts declares and
-- what DRAFT_money_numeric.sql specified for the expand phase.
--
-- DELIBERATELY NOT INCLUDED (see DRAFT_money_numeric.sql):
--   * the `UPDATE … SET x_numeric = x::numeric` backfills — a data rewrite is
--     operator-gated (.claude/rules/database.md), and re-running one on the
--     deployment would clobber values the code has since written directly.
--   * the contract phase (DROP of the old `real` column, RENAME of `_numeric`
--     onto the original name, schema.ts real→numeric). Still gated.
-- This migration ADDs missing columns and nothing else.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost_usd_numeric numeric(18,6);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost_ceiling_usd_numeric numeric(18,6);

ALTER TABLE sprints ADD COLUMN IF NOT EXISTS cost_usd_numeric numeric(18,6);
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS cost_ceiling_usd_numeric numeric(18,6);

ALTER TABLE work_ledger ADD COLUMN IF NOT EXISTS cost_usd_numeric numeric(18,6);

ALTER TABLE api_cost_tracking ADD COLUMN IF NOT EXISTS cost_usd_numeric numeric(18,6);
ALTER TABLE api_cost_tracking ADD COLUMN IF NOT EXISTS ceiling_usd_numeric numeric(18,6);

ALTER TABLE models_knowledge ADD COLUMN IF NOT EXISTS cost_per_m_in_numeric numeric(18,6);
ALTER TABLE models_knowledge ADD COLUMN IF NOT EXISTS cost_per_m_out_numeric numeric(18,6);
