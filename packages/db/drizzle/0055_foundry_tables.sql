-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Model Foundry tables: specialized model lifecycle from training to promotion.

CREATE TABLE IF NOT EXISTS foundry_models (
    id TEXT PRIMARY KEY,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    domain_bucket TEXT NOT NULL,
    base_model TEXT NOT NULL,
    training_examples INTEGER NOT NULL DEFAULT 0,
    trained_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    shadow_agreement_rate REAL,
    shadow_comparisons INTEGER DEFAULT 0,
    ollama_model_name TEXT,
    provider_model_id TEXT,
    provider TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS foundry_shadow_results (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES foundry_models(id) ON DELETE CASCADE,
    inference_log_id UUID REFERENCES inference_logs(id) ON DELETE SET NULL,
    primary_output_hash TEXT,
    shadow_output_hash TEXT,
    agreement_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS foundry_training_runs (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES foundry_models(id) ON DELETE CASCADE,
    domain_bucket TEXT NOT NULL,
    example_count INTEGER NOT NULL,
    base_model TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_foundry_models_status ON foundry_models(status);
CREATE INDEX IF NOT EXISTS idx_foundry_models_bucket ON foundry_models(domain_bucket);
CREATE INDEX IF NOT EXISTS idx_foundry_shadow_model ON foundry_shadow_results(model_id);
CREATE INDEX IF NOT EXISTS idx_foundry_training_model ON foundry_training_runs(model_id);
