-- SPDX-License-Identifier: MIT
-- Idx: 0131  Tag: 0131_routing_events_model_routed
--
-- Round-6 Phase 4 (ADR 0006): mark which served routing decisions came from the
-- model-level router (SelectionResult.modelRouted) so the scorecard can split
-- model-router vs baseline served quality for the A/B comparison that gates the
-- Phase 5 flip. NULL/false until the serving flip (PLEXO_MODEL_ROUTER) is on.
--
-- Additive, ADD COLUMN IF NOT EXISTS — re-run safe, no lock/rewrite. Pruned by
-- the existing routing_events retention (cron runDataRetention).

ALTER TABLE routing_events ADD COLUMN IF NOT EXISTS model_routed BOOLEAN NOT NULL DEFAULT false;
