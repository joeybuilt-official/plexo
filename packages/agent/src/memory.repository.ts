// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapters for the memory-port extraction batches 1-4
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * The ONLY memory modules in these batches permitted to import the ORM.
 */

import { db, memoryEntries, workspaces, workLedger, tasks } from '@plexo/db'
import { sql, eq, ne, and, desc, inArray } from 'drizzle-orm'
import { sqlArray } from './sql-array.js'
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
    MemoryConsolidationStore,
    ConsolidationCandidate,
    ConsolidationWrite,
    MemoryRetrievalStore,
    MemoryRecord,
    ScoredMemoryRecord,
    MemoryQuery,
    MemoryWriteInput,
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

export class DrizzleMemoryConsolidationStore implements MemoryConsolidationStore {
    async countUnconsolidated(workspaceId: string): Promise<number> {
        const [row] = await db.execute<{ count: number }>(sql`
            SELECT count(*)::int as count FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND type = 'task'
              AND (metadata->>'consolidated')::boolean IS NOT TRUE
        `)
        return row?.count ?? 0
    }

    async listUnconsolidatedBefore(
        workspaceId: string,
        before: Date,
        limit: number,
    ): Promise<ConsolidationCandidate[]> {
        const rows = await db.execute<{ id: string, content: string, created_at: Date | string }>(sql`
            SELECT id, content, created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND type = 'task'
              AND (metadata->>'consolidated')::boolean IS NOT TRUE
              AND created_at < ${before.toISOString()}::timestamp
            ORDER BY created_at ASC
            LIMIT ${limit}
        `)
        // The driver hands back a Date for timestamp columns, but the shape is
        // resolved here rather than trusted downstream — the port promises a Date.
        return rows.map((r) => ({
            id: r.id,
            content: r.content,
            createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
        }))
    }

    async consolidateInto(write: ConsolidationWrite): Promise<void> {
        // One statement: the CTE's INSERT and the DELETE share a snapshot, so
        // the summary and the removal of what it summarizes cannot come apart.
        await db.execute(sql`
            WITH inserted AS (
                INSERT INTO memory_entries (workspace_id, type, content, metadata, created_at)
                VALUES (
                    ${write.workspaceId}::uuid,
                    'task',
                    ${write.content},
                    ${JSON.stringify(write.metadata)}::jsonb,
                    ${write.createdAt.toISOString()}::timestamp
                )
                RETURNING id
            )
            DELETE FROM memory_entries
            WHERE id = ANY(${sqlArray(write.replaceIds, 'uuid')})
        `)
    }
}

/** Shared projection so the vector and text paths cannot drift apart. */
const toRecord = (r: {
    id: string
    workspace_id?: string
    workspaceId?: string
    type: string
    content: string
    shorthand: string | null
    metadata: unknown
    tier: string | null
    confidence: number | null
    namespace?: string | null
    created_at?: Date | string
    createdAt?: Date | string
}): MemoryRecord => {
    const created = r.created_at ?? r.createdAt ?? new Date()
    return {
        id: r.id,
        workspaceId: (r.workspace_id ?? r.workspaceId)!,
        type: r.type,
        content: r.content,
        shorthand: r.shorthand,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        tier: r.tier ?? 'active',
        confidence: r.confidence ?? null,
        namespace: r.namespace ?? 'default',
        createdAt: created instanceof Date ? created : new Date(created),
    }
}

export class DrizzleMemoryRetrievalStore implements MemoryRetrievalStore {
    async workspaceExists(workspaceId: string): Promise<boolean> {
        const rows = await db.select({ id: workspaces.id }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        return rows.length > 0
    }

    async write(record: MemoryWriteInput): Promise<void> {
        await db.insert(memoryEntries).values(record as typeof memoryEntries.$inferInsert)
    }

    async setShorthand(id: string, shorthand: string): Promise<void> {
        await db.update(memoryEntries).set({ shorthand }).where(eq(memoryEntries.id, id))
    }

    async searchByVector(
        query: MemoryQuery & { embedding: number[] },
    ): Promise<ScoredMemoryRecord[]> {
        const vecStr = `[${query.embedding.join(',')}]`
        const typeClause = query.type ? sql`AND type = ${query.type}::memory_type` : sql``
        // ANY(array) matches one or many namespaces without rebuilding the
        // statement per namespace.
        const nsArray = sqlArray(query.namespaces, 'text')

        // Two-phase retrieval: the CASE is the PRIMARY sort key, so a hot entry
        // outranks a closer active one. Distance only orders within a tier.
        const rows = await db.execute<Parameters<typeof toRecord>[0] & { similarity: number }>(sql`
      SELECT id, workspace_id, type, content, shorthand, metadata, tier, confidence, namespace, created_at,
             1 - (embedding <=> ${vecStr}::vector) AS similarity
      FROM memory_entries
      WHERE workspace_id = ${query.workspaceId}::uuid
        AND embedding IS NOT NULL
        AND tier != 'cold'
        AND namespace = ANY(${nsArray})
        ${typeClause}
      ORDER BY
        CASE tier WHEN 'hot' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC,
        embedding <=> ${vecStr}::vector ASC
      LIMIT ${query.limit}
    `)
        return rows.map((r) => ({ ...toRecord(r), similarity: r.similarity }))
    }

    async searchByText(query: MemoryQuery & { text?: string }): Promise<MemoryRecord[]> {
        const conditions: NonNullable<Parameters<typeof and>[0]>[] = [
            eq(memoryEntries.workspaceId, query.workspaceId),
            ne(memoryEntries.tier, 'cold'),
            inArray(memoryEntries.namespace, query.namespaces),
        ]
        const text = query.text?.trim()
        if (text) {
            conditions.push(sql`content ILIKE ${'%' + text.split(' ').slice(0, 5).join('%') + '%'}`)
        }
        if (query.type) conditions.push(eq(memoryEntries.type, query.type as never))

        const rows = await db.select().from(memoryEntries)
            .where(and(...conditions))
            .orderBy(desc(memoryEntries.createdAt))
            .limit(query.limit)
        return rows.map((r) => toRecord(r as unknown as Parameters<typeof toRecord>[0]))
    }

    async promoteToHot(ids: string[]): Promise<void> {
        if (ids.length === 0) return
        await db.execute(
            sql`UPDATE memory_entries SET tier = 'hot' WHERE id = ANY(${sqlArray(ids, 'uuid')}) AND tier != 'hot'`,
        )
    }
}
