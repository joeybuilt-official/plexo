// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * memory.extract.requested receiver — Phase 1 of ADR-0010 (Graphiti
 * adoption). Replaces the fire-and-forget Promise pipeline at
 * conversation-bridge.ts → extract-worker with durable, per-workspace
 * serialized, DLQ-visible extraction.
 *
 * The extraction logic itself is unchanged (see extract-worker.ts);
 * only the call boundary moved.
 */

import { inngest } from '@plexo/queue/inngest'
import { extractTurn } from '../extract-worker.js'

export interface ExtractTurnEventData {
    workspaceId: string
    userMessage: string
    assistantReply: string
    sessionId: string
    source: string
}

/**
 * Pure inner business logic — invoked from inside step.run for retry
 * memoization. Extracted so it can be unit-tested without mocking the
 * Inngest step surface.
 */
export async function extractTurnFromEvent(data: ExtractTurnEventData): Promise<{ ok: true }> {
    await extractTurn(data)
    return { ok: true }
}

// Per-workspace burst guard. Background episode extraction routes through the
// workspace's schema-mode (extraction) provider chain — when its cloud JSON
// providers are simultaneously rate-limited, a burst of turns overruns them and
// terminal-fails (dropping the episode). Throttling smooths the burst: Inngest
// durably QUEUES the excess (nothing is dropped, just delayed) so steady demand
// stays under the providers' per-minute ceiling. Tune/disable via
// PLEXO_MEMORY_EXTRACT_THROTTLE_PER_MIN (0 = off). Default sits above normal
// steady-state so it only bites on spikes.
const extractThrottlePerMin = Number(process.env.PLEXO_MEMORY_EXTRACT_THROTTLE_PER_MIN ?? 20)

export const extractTurnFn = inngest.createFunction(
    {
        id: 'memory-extract-turn',
        // Per-workspace serialization preserves temporal consistency.
        // Aggregate throughput scales with distinct workspace_ids in flight.
        concurrency: { key: 'event.data.workspaceId', limit: 1 },
        ...(extractThrottlePerMin > 0
            ? { throttle: { key: 'event.data.workspaceId', limit: extractThrottlePerMin, period: '1m' as const } }
            : {}),
        // Bounded retries while extractTurn is non-idempotent (each retry
        // can re-insert facts on a partial-failure scenario). Phase 5 cuts
        // over to Graphiti's add_episode which is idempotent at the episode
        // level; retry counts can rise then.
        retries: 1,
    },
    { event: 'memory.extract.requested' },
    async ({ event, step }) => step.run('extract-turn', () => extractTurnFromEvent(event.data)),
)
