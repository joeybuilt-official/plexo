// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the model-knowledge port (Stage 3). The only knowledge
 * module permitted to import the ORM. The upsert is the one that used to sit
 * in `providers/knowledge.ts`, including its A6 dual-write of each per-token
 * rate to both the `real` and the `numeric` column.
 */

import { db, modelsKnowledge } from '@plexo/db'
import { sql } from 'drizzle-orm'
import type { ModelKnowledgeStore, ModelKnowledgeRecord } from './model-knowledge.ports.js'

/**
 * Paginated upserts bound memory and connection usage (GAP-004): one
 * `INSERT … VALUES (…),(…) ON CONFLICT DO UPDATE` per batch rather than N
 * single-row statements.
 */
const BATCH_SIZE = 50

export class DrizzleModelKnowledgeStore implements ModelKnowledgeStore {
    async upsertAll(records: ModelKnowledgeRecord[]): Promise<void> {
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE)
            // A6 cutover: dual-write per-token rates to both real + numeric.
            await db.insert(modelsKnowledge)
                .values(batch.map(record => ({
                    id: record.id,
                    provider: record.provider,
                    modelId: record.modelId,
                    contextWindow: record.contextWindow,
                    costPerMIn: record.costPerMIn,
                    costPerMInNumeric: String(record.costPerMIn),
                    costPerMOut: record.costPerMOut,
                    costPerMOutNumeric: String(record.costPerMOut),
                    strengths: record.strengths,
                    lastSyncedAt: record.lastSyncedAt,
                })))
                .onConflictDoUpdate({
                    target: modelsKnowledge.id,
                    set: {
                        contextWindow: sql`excluded.context_window`,
                        costPerMIn: sql`excluded.cost_per_m_in`,
                        costPerMInNumeric: sql`excluded.cost_per_m_in_numeric`,
                        costPerMOut: sql`excluded.cost_per_m_out`,
                        costPerMOutNumeric: sql`excluded.cost_per_m_out_numeric`,
                        strengths: sql`excluded.strengths`,
                        lastSyncedAt: sql`excluded.last_synced_at`,
                    },
                })
        }
    }
}
