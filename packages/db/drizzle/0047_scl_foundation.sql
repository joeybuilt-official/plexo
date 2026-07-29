-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- SCL Foundation: inference logging for future auto-distillation pipeline.
-- NO content, NO prompts, NO completions stored — metadata only.

CREATE TABLE IF NOT EXISTS inference_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_uuid TEXT,
    model TEXT NOT NULL,
    provider TEXT,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    domain_region TEXT,
    task_type TEXT NOT NULL DEFAULT 'unknown',
    success BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inference_logs_domain_idx ON inference_logs (domain_region);
CREATE INDEX IF NOT EXISTS inference_logs_created_idx ON inference_logs (created_at);
CREATE INDEX IF NOT EXISTS inference_logs_model_idx ON inference_logs (model);

-- SCL concept graph schema (empty — populated by future training pipeline)
CREATE TABLE IF NOT EXISTS scl_concept_graphs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_log_id UUID REFERENCES inference_logs(id) ON DELETE SET NULL,
    domain_region TEXT,
    graph_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
