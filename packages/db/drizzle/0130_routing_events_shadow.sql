-- SPDX-License-Identifier: AGPL-3.0-only
-- Idx: 0130  Tag: 0130_routing_events_shadow
--
-- Round-6 Phase 1 (ADR 0006): model-level router shadow logging. Records what
-- the model-level router WOULD pick alongside the model actually served, so the
-- choice can be A/B-compared (Phase 4 scorecard) before any flip (Phase 5).
--
-- `shadow_model_choice` is a JSON string: {chosen, prior, shortlist[], reason}.
-- Written only when the PLEXO_MODEL_ROUTER flag is on; NULL otherwise. The
-- served `provider`/`model` columns are unaffected — shadow logging never
-- changes the model served.
--
-- Additive, ADD COLUMN IF NOT EXISTS — re-run safe, no lock/rewrite.

ALTER TABLE routing_events ADD COLUMN IF NOT EXISTS shadow_model_choice TEXT;
