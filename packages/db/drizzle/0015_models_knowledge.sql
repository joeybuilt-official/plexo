-- Migration 0015: Add models_knowledge table for automated model routing
-- Stores cached knowledge about AI models (context window, cost, strengths,
-- reliability score) so the agent can make routing decisions without hitting
-- provider APIs on every task.

CREATE TABLE IF NOT EXISTS "models_knowledge" (
    "id"               text PRIMARY KEY NOT NULL,
    "provider"         text NOT NULL,
    "model_id"         text NOT NULL,
    "context_window"   integer NOT NULL DEFAULT 128000,
    "cost_per_m_in"    real NOT NULL,
    "cost_per_m_out"   real NOT NULL,
    "strengths"        jsonb NOT NULL DEFAULT '[]'::jsonb,
    "reliability_score" real NOT NULL DEFAULT 1.0,
    "last_synced_at"   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "models_knowledge_provider_idx" ON "models_knowledge" ("provider");
CREATE INDEX IF NOT EXISTS "models_knowledge_model_idx"    ON "models_knowledge" ("model_id");
