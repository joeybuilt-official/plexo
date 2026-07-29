-- SPDX-License-Identifier: MIT
-- Idx: 0133  Tag: 0133_provider_balance_exhausted
--
-- Fix A (chat-capacity): persist provider funds-depletion state.
--
-- When a provider instance returns a hard "Insufficient Balance" / 402 error,
-- the router marks balance_exhausted_at and excludes the instance from the
-- routing chain (so it stops wasting a cascade slot + latency on a dead
-- primary, e.g. an out-of-credit deepseek). The web app surfaces a site-wide
-- dismissible notice; operator dismissal clears this column and re-arms the
-- provider. NULL = healthy. Additive + idempotent — safe to apply live.

ALTER TABLE provider_instances
    ADD COLUMN IF NOT EXISTS balance_exhausted_at timestamptz;
