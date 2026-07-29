-- SPDX-License-Identifier: MIT
-- Idx: 0129  Tag: 0129_inference_logs_app_id
--
-- Round-5 Phase 6 (WS E): per-app cost attribution.
--
-- The inference proxy (graphiti/Fonto, identified by X-App-Id) previously wrote
-- NO inference_logs row, so app spend was invisible. Phase 6 adds a fire-and-
-- forget proxy-side write tagged with app_id. This column captures it.
--
-- ATTRIBUTION-ONLY (operator decision 2026-06-06): the cost-enforcement gate
-- (getWorkspaceSpend) excludes rows where app_id IS NOT NULL, so adding proxy
-- spend does NOT trip the $50 ceiling on the over-budget ws. Attribution
-- queries (loadAppSpend) count all rows.
--
-- Additive, nullable, no backfill — re-run safe.

ALTER TABLE inference_logs ADD COLUMN IF NOT EXISTS app_id TEXT;

CREATE INDEX IF NOT EXISTS inference_logs_app_idx
    ON inference_logs(app_id, created_at DESC)
    WHERE app_id IS NOT NULL;
