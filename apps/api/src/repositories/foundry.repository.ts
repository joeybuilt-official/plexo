// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model Foundry data-access repository (read-only).
 *
 * owns the foundry_models listing query. The route keeps
 * admin auth, validation, and the promote/retire/train orchestration (which
 * lives in @plexo/agent/foundry).
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** All foundry models, newest first. */
export async function listModels() {
    return db.execute(sql`
        SELECT id, workspace_id, domain_bucket, base_model, training_examples,
               trained_at, status, shadow_agreement_rate, shadow_comparisons,
               ollama_model_name, provider_model_id, provider, created_at
        FROM foundry_models
        ORDER BY created_at DESC
    `)
}
