// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Compares the most recent two memory-coherence rollups; alerts if the
 * latest rerun dropped > 10% relative to the previous run.
 *
 * Memory subsystem itself is owned by Alpha/November — this agent only
 * reads the persisted rollup table and never writes to memory data.
 */

import type { Agent, Alert } from './index.js'

const DROP_THRESHOLD = parseFloat(process.env.COHERENCE_DROP_THRESHOLD ?? '0.10')

export const memoryCoherenceLow: Agent = {
    name: 'memory-coherence-low',
    intervalSec: 60 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        try {
            const { db, sql } = await import('@plexo/db')
            // Check the table exists; some deployments don't run synthesis
            const probe = await db.execute<{ exists: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'memory_coherence_runs'
                ) AS exists
            `)
            if (!probe[0]?.exists) return null

            interface CoherenceRow extends Record<string, unknown> {
                avg_coherence: number
                created_at: Date
            }
            const rows = await db.execute<CoherenceRow>(sql`
                SELECT avg_coherence, created_at
                FROM memory_coherence_runs
                ORDER BY created_at DESC
                LIMIT 2
            `)
            if (rows.length < 2) return null
            const latest = rows[0]!
            const prev = rows[1]!
            const drop = prev.avg_coherence > 0 ? (prev.avg_coherence - latest.avg_coherence) / prev.avg_coherence : 0
            if (drop > DROP_THRESHOLD) {
                return {
                    agent: 'memory-coherence-low',
                    at,
                    severity: 'warn',
                    message: `Memory coherence dropped ${(drop * 100).toFixed(1)}% (${prev.avg_coherence.toFixed(3)} → ${latest.avg_coherence.toFixed(3)})`,
                    metadata: {
                        previous: prev.avg_coherence,
                        latest: latest.avg_coherence,
                        drop,
                        threshold: DROP_THRESHOLD,
                    },
                }
            }
            return null
        } catch (err) {
            return {
                agent: 'memory-coherence-low',
                at,
                severity: 'warn',
                message: `Coherence probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
