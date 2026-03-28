// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Event-Driven Memory Consolidation
 *
 * Prevents unbounded memory growth by consolidating old memories
 * into summary entries. Triggered by events (task completion) rather
 * than fixed time intervals.
 *
 * Rules:
 * - Task memories older than 7 days are grouped by week and summarized
 * - Consolidation fires when a workspace exceeds 50 un-consolidated memories
 * - Consolidated entries have metadata.consolidated = true
 * - Individual entries are deleted within the same transaction
 * - Pattern memories are not consolidated (they're already summaries)
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { eventBus, TOPICS } from '../plugins/event-bus.js'

const logger = pino({ name: 'memory.consolidation' })

const CONSOLIDATION_THRESHOLD = 50
const CONSOLIDATION_AGE_DAYS = 7
const MAX_MEMORIES_PER_CONSOLIDATED = 20

interface MemoryRow {
    id: string
    content: string
    type: string
    createdAt: Date
    metadata: Record<string, unknown> | null
    [key: string]: unknown
}

/**
 * Check if a workspace needs consolidation and run it if so.
 * Called after task completion events.
 */
export async function maybeConsolidate(workspaceId: string): Promise<{ consolidated: number }> {
    try {
        // Count un-consolidated task memories
        const [row] = await db.execute<{ count: number }>(sql`
            SELECT count(*)::int as count FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND type = 'task'
              AND (metadata->>'consolidated')::boolean IS NOT TRUE
        `)
        const count = row?.count ?? 0

        if (count < CONSOLIDATION_THRESHOLD) {
            return { consolidated: 0 }
        }

        logger.info({ workspaceId, memoryCount: count }, 'Memory consolidation threshold exceeded — starting consolidation')
        return await consolidateWorkspaceMemories(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Consolidation check failed — non-fatal')
        return { consolidated: 0 }
    }
}

/**
 * Consolidate old task memories into weekly summaries.
 */
async function consolidateWorkspaceMemories(workspaceId: string): Promise<{ consolidated: number }> {
    const cutoff = new Date(Date.now() - CONSOLIDATION_AGE_DAYS * 24 * 60 * 60 * 1000)

    // Fetch old, un-consolidated task memories
    const oldMemories = await db.execute<MemoryRow>(sql`
        SELECT id, content, type, created_at as "createdAt", metadata
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND type = 'task'
          AND (metadata->>'consolidated')::boolean IS NOT TRUE
          AND created_at < ${cutoff}
        ORDER BY created_at ASC
        LIMIT 200
    `)

    if (oldMemories.length === 0) return { consolidated: 0 }

    // Group by ISO week (YYYY-WNN)
    const byWeek = new Map<string, MemoryRow[]>()
    for (const mem of oldMemories) {
        const d = mem.createdAt instanceof Date ? mem.createdAt : new Date(mem.createdAt)
        const weekKey = getISOWeek(d)
        const list = byWeek.get(weekKey) ?? []
        list.push(mem)
        byWeek.set(weekKey, list)
    }

    let totalConsolidated = 0

    for (const [weekKey, memories] of byWeek) {
        if (memories.length < 2) continue // Don't consolidate singletons

        // Build summary from the memories in this week
        const summaryLines = memories.slice(0, MAX_MEMORIES_PER_CONSOLIDATED).map(m =>
            m.content.slice(0, 200)
        )
        const summaryContent = `[Consolidated ${memories.length} task memories from week ${weekKey}]\n\n${summaryLines.join('\n---\n')}`

        const idsToDelete = memories.map(m => m.id)

        // Atomic: insert consolidated entry + delete individuals
        try {
            await db.execute(sql`
                WITH inserted AS (
                    INSERT INTO memory_entries (workspace_id, type, content, metadata, created_at)
                    VALUES (
                        ${workspaceId}::uuid,
                        'task',
                        ${summaryContent},
                        ${JSON.stringify({ consolidated: true, sourceCount: memories.length, weekOf: weekKey })}::jsonb,
                        ${memories[0]!.createdAt}
                    )
                    RETURNING id
                )
                DELETE FROM memory_entries
                WHERE id = ANY(${idsToDelete}::uuid[])
            `)
            totalConsolidated += memories.length
            logger.info({ workspaceId, weekKey, count: memories.length }, 'Consolidated week memories')
        } catch (err) {
            logger.warn({ err, workspaceId, weekKey }, 'Failed to consolidate week — skipping')
        }
    }

    if (totalConsolidated > 0) {
        eventBus.publish(TOPICS.MEMORY_CONSOLIDATED, {
            workspaceId,
            consolidated: totalConsolidated,
            timestamp: new Date().toISOString(),
        })
    }

    return { consolidated: totalConsolidated }
}

/** Get ISO week string like "2026-W13" */
function getISOWeek(date: Date): string {
    const d = new Date(date.getTime())
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
    const week1 = new Date(d.getFullYear(), 0, 4)
    const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

// ── Event subscription ──────────────────────────────────────────────────────

/**
 * Initialize the consolidation event listener.
 * Call once at startup to subscribe to task completion events.
 */
export function initConsolidationListener(): void {
    eventBus.subscribe(TOPICS.TASK_COMPLETED, async (payload: unknown) => {
        const { workspaceId } = payload as { workspaceId?: string }
        if (!workspaceId) return
        // Non-blocking — don't slow down task completion
        void maybeConsolidate(workspaceId).catch(err =>
            logger.warn({ err, workspaceId }, 'Event-driven consolidation failed')
        )
    })
    logger.info('Memory consolidation listener registered on TASK_COMPLETED events')
}
