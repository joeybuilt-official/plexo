-- Migration: per-task and per-project token/cost budget caps
-- Phase: token_budgets
-- Null = inherit from level above (workspace default → project default → task explicit)

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS cost_ceiling_usd real,
    ADD COLUMN IF NOT EXISTS token_budget integer;

ALTER TABLE sprints
    ADD COLUMN IF NOT EXISTS cost_ceiling_usd real;
