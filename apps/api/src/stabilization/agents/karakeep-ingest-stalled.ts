// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Karakeep is an optional bookmark-ingest source. When configured, the
 * stalled-ingest watchdog alerts if no new bookmark has landed in 24h.
 *
 * Disabled by default. Enable with `KARAKEEP_MONITOR=1`.
 */

import type { Agent, Alert } from './index.js'

const STALL_MS = 24 * 60 * 60 * 1000

export const karakeepIngestStalled: Agent = {
    name: 'karakeep-ingest-stalled',
    intervalSec: 30 * 60,
    async check(): Promise<Alert | null> {
        if (process.env.KARAKEEP_MONITOR !== '1') return null
        const at = new Date().toISOString()
        try {
            const { db, sql } = await import('@plexo/db')
            const probe = await db.execute<{ exists: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'karakeep_bookmarks'
                ) AS exists
            `)
            if (!probe[0]?.exists) {
                return {
                    agent: 'karakeep-ingest-stalled',
                    at,
                    severity: 'warn',
                    message: 'KARAKEEP_MONITOR=1 but karakeep_bookmarks table missing',
                }
            }
            const rows = await db.execute<{ latest: Date | null }>(sql`
                SELECT MAX(created_at) AS latest FROM karakeep_bookmarks
            `)
            const latest = rows[0]?.latest
            if (!latest) {
                return {
                    agent: 'karakeep-ingest-stalled',
                    at,
                    severity: 'warn',
                    message: 'Karakeep table exists but has no rows',
                }
            }
            const ageMs = Date.now() - new Date(latest).getTime()
            if (ageMs > STALL_MS) {
                return {
                    agent: 'karakeep-ingest-stalled',
                    at,
                    severity: 'warn',
                    message: `Karakeep ingest stalled — latest bookmark ${Math.round(ageMs / 3600_000)}h old`,
                    metadata: { ageHours: Math.round(ageMs / 3600_000) },
                }
            }
            return null
        } catch (err) {
            return {
                agent: 'karakeep-ingest-stalled',
                at,
                severity: 'warn',
                message: `Karakeep probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
