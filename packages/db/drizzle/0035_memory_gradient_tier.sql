-- Memory Gradient: add tier column to memory_entries
-- Tier controls retrieval priority and eviction strategy.
-- Values: 'hot' (recent/high-signal), 'active' (default), 'cold' (aged-out)
ALTER TABLE "memory_entries" ADD COLUMN "tier" text NOT NULL DEFAULT 'active';
