// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Alerts when synthesis hasn't produced any new suggestions in 48 hours.
 * Synthesis may be silently broken (model errors, empty results, dead
 * cron) without surfacing to users — this catches that state.
 *
 * Out of scope per stabilization plan: actually fixing synthesis. We just
 * detect it. November owns the synthesis subsystem.
 */

import type { Agent, Alert } from './index.js'

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000

export const synthesisSuggestionsStale: Agent = {
    name: 'synthesis-suggestions-stale',
    intervalSec: 60 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        try {
            const { db, sql } = await import('@plexo/db')
            // The synthesis_suggestions table may not exist on every deployment;
            // we tolerate that and treat it as "nothing to monitor".
            const probe = await db.execute<{ exists: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'synthesis_suggestions'
                ) AS exists
            `)
            if (!probe[0]?.exists) return null

            const rows = await db.execute<{ latest: Date | null }>(sql`
                SELECT MAX(created_at) AS latest FROM synthesis_suggestions
            `)
            const latest = rows[0]?.latest
            if (!latest) {
                // No rows ever created — informational only
                return {
                    agent: 'synthesis-suggestions-stale',
                    at,
                    severity: 'warn',
                    message: 'No synthesis suggestions have ever been created',
                }
            }
            const ageMs = Date.now() - new Date(latest).getTime()
            if (ageMs > STALE_THRESHOLD_MS) {
                return {
                    agent: 'synthesis-suggestions-stale',
                    at,
                    severity: 'warn',
                    message: `Latest synthesis suggestion is ${Math.round(ageMs / 3600_000)}h old (>48h threshold)`,
                    metadata: { ageHours: Math.round(ageMs / 3600_000), latestAt: latest },
                }
            }
            return null
        } catch (err) {
            return {
                agent: 'synthesis-suggestions-stale',
                at,
                severity: 'warn',
                message: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
