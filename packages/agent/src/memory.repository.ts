// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapters for the memory-port extraction batches 1-3
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * The ONLY memory modules in these batches permitted to import the ORM.
 */

import { db, memoryEntries, workLedger, tasks } from '@plexo/db'
import { sql, eq, desc } from 'drizzle-orm'
import type {
    BehaviorRuleStore,
    BehaviorRuleInput,
    MemoryEntryStore,
    MemoryEntryInput,
    PreferenceStore,
    PreferenceRecord,
    PreferenceUpsertInput,
    ImprovementLogStore,
    ImprovementLogChallenger,
    VariantOutcome,
    ImprovementProposalInput,
    ImprovementLogProposal,
    ImprovementLogEntry,
    WorkLedgerSampleStore,
    WorkLedgerPromptSample,
    WorkLedgerOutcomeSample,
    TaskOutcomeSample,
} from './memory.ports.js'

export class DrizzleBehaviorRuleStore implements BehaviorRuleStore {
    async insertIfAbsent(record: BehaviorRuleInput): Promise<void> {
        await db.execute(sql`
            INSERT INTO behavior_rules
                (id, workspace_id, type, key, label, description, value, source, tags)
            VALUES
                (gen_random_uuid(), ${record.workspaceId}::uuid,
                 ${record.type}, ${record.key}, ${record.label}, ${record.description},
                 ${JSON.stringify(record.value)}::jsonb,
                 ${record.source}, ARRAY[${sql.join(record.tags.map((t) => sql`${t}`), sql`, `)}]::text[])
            ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
            DO NOTHING
        `)
    }

    async upsert(record: BehaviorRuleInput): Promise<void> {
        await db.execute(sql`
            INSERT INTO behavior_rules
                (id, workspace_id, type, key, label, description, value, source, tags)
            VALUES
                (gen_random_uuid(), ${record.workspaceId}::uuid,
                 ${record.type}, ${record.key}, ${record.label}, ${record.description},
                 ${JSON.stringify(record.value)}::jsonb,
                 ${record.source}, ARRAY[${sql.join(record.tags.map((t) => sql`${t}`), sql`, `)}]::text[])
            ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
            DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = now()
        `)
    }
}

export class DrizzleMemoryEntryStore implements MemoryEntryStore {
    async insert(record: MemoryEntryInput): Promise<void> {
        await db.insert(memoryEntries).values(record as typeof memoryEntries.$inferInsert)
    }

    async setEmbedding(id: string, embedding: number[]): Promise<void> {
        const vecStr = `[${embedding.join(',')}]`
        await db.execute(sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`)
    }
}

export class DrizzlePreferenceStore implements PreferenceStore {
    async listByWorkspace(workspaceId: string): Promise<PreferenceRecord[]> {
        return db.execute<{ key: string; value: unknown; confidence: number }>(sql`
            SELECT key, value, confidence
            FROM workspace_preferences
            WHERE workspace_id = ${workspaceId}::uuid
            ORDER BY confidence DESC
        `)
    }

    async getValue(workspaceId: string, key: string): Promise<unknown | null> {
        const rows = await db.execute<{ value: unknown }>(sql`
            SELECT value FROM workspace_preferences
            WHERE workspace_id = ${workspaceId}::uuid AND key = ${key}
            LIMIT 1
        `)
        return rows[0]?.value ?? null
    }

    async upsert(record: PreferenceUpsertInput): Promise<void> {
        await db.execute(sql`
            INSERT INTO workspace_preferences (workspace_id, key, value, confidence, evidence_count, last_updated)
            VALUES (
                ${record.workspaceId}::uuid,
                ${record.key},
                ${JSON.stringify(record.value)}::jsonb,
                ${record.confidence},
                1,
                now()
            )
            ON CONFLICT (workspace_id, key)
            DO UPDATE SET
                value = EXCLUDED.value,
                confidence = LEAST(0.95, workspace_preferences.confidence + (EXCLUDED.confidence * 0.1)),
                evidence_count = workspace_preferences.evidence_count + 1,
                last_updated = now()
        `)
    }
}

export class DrizzleImprovementLogStore implements ImprovementLogStore {
    async selectPendingChallenger(workspaceId: string, patternType: string): Promise<ImprovementLogChallenger | null> {
        const rows = await db.execute<{ id: string; proposed_change: string; metadata: unknown }>(sql`
            SELECT id, proposed_change, metadata FROM agent_improvement_log
            WHERE workspace_id = ${workspaceId}::uuid
              AND pattern_type = ${patternType}
              AND applied = false
              AND (metadata->>'discarded')::boolean IS NOT TRUE
            ORDER BY created_at DESC
            LIMIT 1
        `)
        const row = rows[0]
        if (!row) return null
        return { id: row.id, proposedChange: row.proposed_change, metadata: row.metadata }
    }

    async appendVariantOutcome(id: string, outcome: VariantOutcome): Promise<void> {
        await db.execute(sql`
            UPDATE agent_improvement_log
            SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                    'variants', COALESCE(metadata->'variants', '[]'::jsonb) ||
                        jsonb_build_array(jsonb_build_object('v', ${outcome.variant}, 'q', ${outcome.qualityScore}))
                )
            WHERE id = ${id}::uuid
        `)
    }

    async getMetadata(id: string): Promise<unknown | null> {
        const rows = await db.execute<{ metadata: unknown }>(sql`
            SELECT metadata FROM agent_improvement_log
            WHERE id = ${id}::uuid
            LIMIT 1
        `)
        return rows[0]?.metadata ?? null
    }

    async markDiscarded(id: string): Promise<void> {
        await db.execute(sql`
            UPDATE agent_improvement_log
            SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"discarded": true}'::jsonb
            WHERE id = ${id}::uuid
        `)
    }

    async getProposedChange(id: string): Promise<string | null> {
        const rows = await db.execute<{ proposed_change: string }>(sql`
            SELECT proposed_change FROM agent_improvement_log
            WHERE id = ${id}::uuid
            LIMIT 1
        `)
        return rows[0]?.proposed_change ?? null
    }

    async markAutoPromoted(id: string): Promise<void> {
        await db.execute(sql`
            UPDATE agent_improvement_log
            SET applied = true,
                metadata = COALESCE(metadata, '{}'::jsonb) || '{"auto_promoted": true}'::jsonb
            WHERE id = ${id}::uuid
        `)
    }

    async appendProposals(workspaceId: string, proposals: ImprovementProposalInput[]): Promise<void> {
        if (proposals.length === 0) return
        const valueClauses = proposals.map((p) => sql`(
            ${workspaceId}::uuid,
            ${p.patternType},
            ${p.description},
            ${JSON.stringify(p.evidence ?? [])}::jsonb,
            ${p.proposedChange},
            now()
        )`)
        await db.execute(sql`
            INSERT INTO agent_improvement_log
                (workspace_id, pattern_type, description, evidence, proposed_change, created_at)
            VALUES ${sql.join(valueClauses, sql`, `)}
        `)
    }

    async getProposalForWorkspace(workspaceId: string, id: string): Promise<ImprovementLogProposal | null> {
        const rows = await db.execute<{ proposed_change: string; applied: boolean }>(sql`
            SELECT proposed_change, applied FROM agent_improvement_log
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            LIMIT 1
        `)
        const row = rows[0]
        if (!row) return null
        return { proposedChange: row.proposed_change, applied: row.applied }
    }

    async markApplied(id: string): Promise<void> {
        await db.execute(sql`
            UPDATE agent_improvement_log SET applied = true
            WHERE id = ${id}::uuid
        `)
    }

    async listRecent(workspaceId: string, limit: number): Promise<ImprovementLogEntry[]> {
        const rows = await db.execute<{
            id: string
            pattern_type: string
            description: string
            evidence: unknown
            proposed_change: string | null
            applied: boolean
            created_at: Date
        }>(sql`
            SELECT id, pattern_type, description, evidence, proposed_change, applied, created_at
            FROM agent_improvement_log
            WHERE workspace_id = ${workspaceId}::uuid
            ORDER BY created_at DESC
            LIMIT ${limit}
        `)
        return rows.map((row) => ({
            id: row.id,
            patternType: row.pattern_type,
            description: row.description,
            evidence: row.evidence,
            proposedChange: row.proposed_change,
            applied: row.applied,
            createdAt: row.created_at,
        }))
    }
}

export class DrizzleWorkLedgerSampleStore implements WorkLedgerSampleStore {
    async selectPromptSamples(workspaceId: string, limit: number): Promise<WorkLedgerPromptSample[]> {
        return db.select({
            taskId: workLedger.taskId,
            type: workLedger.type,
            qualityScore: workLedger.qualityScore,
            calibration: workLedger.calibration,
            tokensIn: workLedger.tokensIn,
            deliverables: workLedger.deliverables,
            wallClockMs: workLedger.wallClockMs,
        }).from(workLedger)
            .where(eq(workLedger.workspaceId, workspaceId))
            .orderBy(desc(workLedger.completedAt))
            .limit(limit)
    }

    async selectOutcomeSamples(workspaceId: string, limit: number): Promise<WorkLedgerOutcomeSample[]> {
        return db.select({
            taskId: workLedger.taskId,
            type: workLedger.type,
            qualityScore: workLedger.qualityScore,
            confidenceScore: workLedger.confidenceScore,
            calibration: workLedger.calibration,
            tokensIn: workLedger.tokensIn,
            tokensOut: workLedger.tokensOut,
            deliverables: workLedger.deliverables,
            wallClockMs: workLedger.wallClockMs,
            completedAt: workLedger.completedAt,
        }).from(workLedger)
            .where(eq(workLedger.workspaceId, workspaceId))
            .orderBy(desc(workLedger.completedAt))
            .limit(limit)
    }

    async selectTaskOutcomeSamples(workspaceId: string, limit: number): Promise<TaskOutcomeSample[]> {
        return db.select({
            id: tasks.id,
            type: tasks.type,
            qualityScore: tasks.qualityScore,
            confidenceScore: tasks.confidenceScore,
            tokensIn: tasks.tokensIn,
            tokensOut: tasks.tokensOut,
            outcomeSummary: tasks.outcomeSummary,
            completedAt: tasks.completedAt,
        }).from(tasks)
            .where(eq(tasks.workspaceId, workspaceId))
            .orderBy(desc(tasks.completedAt))
            .limit(limit)
    }
}
