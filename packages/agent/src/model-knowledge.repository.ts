// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the model-knowledge port (Stage 3). The only knowledge
 * module permitted to import the ORM. The upsert is the one that used to sit
 * in `providers/knowledge.ts`, including its A6 dual-write of each per-token
 * rate to both the `real` and the `numeric` column.
 */

import { db, modelsKnowledge } from '@plexo/db'
import { eq, sql } from 'drizzle-orm'
import type {
    ModelKnowledgeStore,
    ModelKnowledgeRecord,
    ModelCatalogStore,
    ModelCandidate,
    ModelReliabilityStore,
} from './model-knowledge.ports.js'

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

/**
 * Built per call, not hoisted to a module constant: a module-level constant
 * dereferences the drizzle table at IMPORT time, which throws in any test that
 * mocks `@plexo/db` without this table — before a single line of the test runs.
 */
function candidateColumns() {
    return {
        provider: modelsKnowledge.provider,
        modelId: modelsKnowledge.modelId,
        strengths: modelsKnowledge.strengths,
        costPerMIn: modelsKnowledge.costPerMIn,
        costPerMOut: modelsKnowledge.costPerMOut,
    }
}

export class DrizzleModelCatalogStore implements ModelCatalogStore {
    async findByStrengths(requiredStrengths: string[], limit: number): Promise<ModelCandidate[]> {
        // FUN-023: `@>` containment against the FULL required array, not just [0].
        return db.select(candidateColumns())
            .from(modelsKnowledge)
            .where(sql`${modelsKnowledge.strengths} @> ${JSON.stringify(requiredStrengths)}::jsonb`)
            .orderBy(modelsKnowledge.costPerMIn)
            .limit(limit)
    }

    async listCheapest(limit: number): Promise<ModelCandidate[]> {
        return db.select(candidateColumns())
            .from(modelsKnowledge)
            .orderBy(modelsKnowledge.costPerMIn)
            .limit(limit)
    }
}

export class DrizzleModelReliabilityStore implements ModelReliabilityStore {
    async getReliability(modelId: string): Promise<number | null> {
        const [row] = await db.select({ score: modelsKnowledge.reliabilityScore })
            .from(modelsKnowledge)
            .where(eq(modelsKnowledge.modelId, modelId))
            .limit(1)
        return row?.score ?? null
    }

    async adjustReliability(modelId: string, delta: number, floor: number, ceil: number): Promise<void> {
        await db.execute(sql`
            UPDATE models_knowledge
            SET reliability_score = GREATEST(
                ${floor},
                LEAST(${ceil}, reliability_score + ${delta})
            )
            WHERE model_id = ${modelId}
        `)
    }
}
