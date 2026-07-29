// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * One-time flush of stale Valkey/Redis keys from the pre-rebuild memory system.
 *
 * Background: the SCL/mindset/golden-record memory architecture was replaced by
 * the atomic-fact memory_entries system. No live code writes the old key
 * patterns (verified via Phase 0 audit), but deployed Valkey instances may
 * still hold stale keys from before the cutover. This script SCANs and DELs
 * them. Safe to re-run.
 *
 * Usage:
 *   pnpm tsx scripts/flush-stale-memory-keys.ts          # local
 *   REDIS_URL=redis://prod-host:6379 pnpm tsx ...        # explicit target
 *
 * IMPORTANT: do not run against production without operator sign-off.
 *
 * Patterns flushed:
 *   mindset:*
 *   golden-record:*       golden_record:*
 *   scl:*
 *   workspace_mindsets:*
 *   attractor:*
 *
 * Patterns preserved (current system — never delete):
 *   memory:prefetch:*
 *   memory:retrieval-events
 *   health-monitor:*
 *   owd:*
 *   zeroclaw:parallel:slots
 */

import { createClient } from 'redis'

const STALE_PATTERNS = [
    'mindset:*',
    'golden-record:*',
    'golden_record:*',
    'scl:*',
    'workspace_mindsets:*',
    'attractor:*',
]

const SCAN_BATCH = 500

async function main() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
    console.log(`[flush] Connecting to ${url}`)

    const client = createClient({ url })
    client.on('error', (err) => console.error('[flush] redis error:', err))
    await client.connect()

    const counts: Record<string, number> = {}
    let totalDeleted = 0

    for (const pattern of STALE_PATTERNS) {
        let matched = 0
        let cursor = 0

        do {
            const result = await client.scan(cursor, { MATCH: pattern, COUNT: SCAN_BATCH })
            cursor = Number(result.cursor)
            const keys = result.keys

            if (keys.length > 0) {
                const deleted = await client.del(keys)
                matched += deleted
            }
        } while (cursor !== 0)

        counts[pattern] = matched
        totalDeleted += matched
        console.log(`[flush] ${pattern} → ${matched} deleted`)
    }

    console.log(`[flush] Total deleted: ${totalDeleted}`)
    console.log(`[flush] Counts:`, counts)

    await client.disconnect()
}

main().catch((err) => {
    console.error('[flush] Failed:', err)
    process.exit(1)
})
