// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * memory.embedding.requested receiver — Phase 3.5 of the Plexo audit plan.
 * Replaces the fire-and-forget Promise pipeline in store.ts with durable,
 * per-workspace serialized, DLQ-visible embedding generation.
 */

import { inngest } from '@plexo/queue/inngest'
import { embed } from '../store.js'

export interface EmbedMemoryEventData {
    workspaceId: string
    memoryEntryId: string
    content: string
    aiSettings?: WorkspaceAISettings
}

/**
 * Pure inner business logic — invoked from inside step.run for retry
 * memoization. Extracted so it can be unit-tested without mocking the
 * Inngest step surface.
 */
export async function embedMemoryFromEvent(data: EmbedMemoryEventData): Promise<{ ok: true; memoryEntryId: string }> {
    const { workspaceId, memoryEntryId, content, aiSettings } = data

    const vector = await embed(content, workspaceId, aiSettings)
    if (!vector) {
        // Embedding failed (provider down, auth error, etc.) — throw so Inngest
        // retries per the function's retry policy, then sends to DLQ.
        throw new Error(`embed() returned null for memory entry ${memoryEntryId}`)
    }

    const vecStr = `[${vector.join(',')}]`
    const { db } = await import('@plexo/db')
    const { sql } = await import('drizzle-orm')
    const { memoryEntries } = await import('@plexo/db')

    await db.execute(
        sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${memoryEntryId}::uuid`,
    )

    return { ok: true, memoryEntryId }
}

// Per-workspace burst guard. Background embedding routes through the
// workspace's embedding provider chain — when its cloud JSON providers are
// simultaneously rate-limited, a burst of writes overruns them. Throttling
// smooths the burst: Inngest durably QUEUES the excess (nothing is dropped,
// just delayed) so steady demand stays under the providers' per-minute ceiling.
const embedThrottlePerMin = Number(process.env.PLEXO_MEMORY_EMBED_THROTTLE_PER_MIN ?? 30)

export const embedMemoryFn = inngest.createFunction(
    {
        id: 'memory-embed-turn',
        // Per-workspace serialization preserves provider quota.
        concurrency: { key: 'event.data.workspaceId', limit: 1 },
        ...(embedThrottlePerMin > 0
            ? { throttle: { key: 'event.data.workspaceId', limit: embedThrottlePerMin, period: '1m' as const } }
            : {}),
        // Bounded retries: 3 attempts with exponential backoff (Inngest default).
        // After retries exhaust, the event lands in the Inngest DLQ for manual
        // inspection/replay — visible in the Inngest dashboard.
        retries: 3,
    },
    { event: 'memory.embedding.requested' },
    async ({ event, step }) => step.run('embed-memory', () => embedMemoryFromEvent(event.data)),
)