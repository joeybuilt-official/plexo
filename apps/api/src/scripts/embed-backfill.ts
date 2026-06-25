// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embedding backfill — Phase 1.
 *
 * Iterates over `memory_entries WHERE workspace_id=$1 AND embedding IS NULL`
 * in batches of 100, calls embed() (Phase 1: Xenova/multilingual-e5-small,
 * 384-d) and writes the vector back via raw SQL. Resumable: rows that
 * already have an embedding are skipped on re-run.
 *
 * Run inside the API container:
 *     docker exec -i plexo-api node \
 *         --import tsx /app/apps/api/src/scripts/embed-backfill.ts <workspaceId>
 *
 * The script logs progress every batch so a long-running session can be
 * monitored. Exits non-zero if any embedding call fails permanently after
 * the embed() helper's internal fallbacks.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { embed } from '@plexo/agent/memory/store'

const BATCH = 100

interface PendingRow extends Record<string, unknown> {
    id: string
    content: string
}

async function countPending(workspaceId: string): Promise<number> {
    const rows = Array.from(await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NULL
    `))
    return rows[0]?.n ?? 0
}

async function loadBatch(workspaceId: string, batchSize: number): Promise<PendingRow[]> {
    const rows = Array.from(await db.execute<PendingRow>(sql`
        SELECT id, content
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${batchSize}
    `))
    return rows
}

async function writeEmbedding(id: string, vector: number[]): Promise<void> {
    const vecStr = `[${vector.join(',')}]`
    await db.execute(sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`)
}

async function main(): Promise<void> {
    const workspaceId = process.argv[2]
    if (!workspaceId) {
        console.error('usage: embed-backfill <workspaceId>')
        process.exit(1)
    }
    const t0 = Date.now()
    let totalBefore = await countPending(workspaceId)
    console.log(`embed-backfill: workspace=${workspaceId} pending=${totalBefore}`)

    let processed = 0
    let succeeded = 0
    let failed = 0
    while (true) {
        const batch = await loadBatch(workspaceId, BATCH)
        if (batch.length === 0) break
        for (const row of batch) {
            try {
                const vec = await embed(row.content, workspaceId)
                if (!vec) {
                    failed++
                    console.warn(`[${row.id}] embed() returned null — provider unavailable; aborting`)
                    process.exit(2)
                }
                if (vec.length !== 384) {
                    failed++
                    console.error(`[${row.id}] expected 384-d, got ${vec.length}-d — embedding floor violation`)
                    process.exit(3)
                }
                await writeEmbedding(row.id, vec)
                succeeded++
            } catch (err) {
                failed++
                console.error(`[${row.id}] error:`, err instanceof Error ? err.message : String(err))
            }
            processed++
            if (processed % 25 === 0) {
                console.log(`  progress=${processed}/${totalBefore} succeeded=${succeeded} failed=${failed}`)
            }
        }
    }

    const totalAfter = await countPending(workspaceId)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`embed-backfill done: processed=${processed} succeeded=${succeeded} failed=${failed} pending_before=${totalBefore} pending_after=${totalAfter} elapsed=${elapsed}s`)
    process.exit(failed > 0 || totalAfter > 0 ? 1 : 0)
}

main().catch(err => {
    console.error('embed-backfill failed:', err)
    process.exit(1)
})
