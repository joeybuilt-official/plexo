// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Alerts if any enabled cron job has not fired within 2x its schedule
 * interval. Catches dead schedulers that publish no errors but stop
 * dispatching work.
 */

import type { Agent, Alert } from './index.js'
import { CronExpressionParser } from 'cron-parser'

interface JobRow extends Record<string, unknown> {
    name: string
    schedule: string
    enabled: boolean
    last_run_at: Date | null
    next_run_at: Date | null
}

function isLate(job: JobRow): { late: true; expectedIntervalMs: number; sinceLastRun: number } | null {
    if (!job.last_run_at) return null // never run; the next-run check will fire instead
    try {
        const expr = CronExpressionParser.parse(job.schedule, { currentDate: job.last_run_at })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CronDate has valueOf
        const next = (expr.next() as any).valueOf() as number
        const intervalMs = next - job.last_run_at.getTime()
        const sinceLastRun = Date.now() - job.last_run_at.getTime()
        if (sinceLastRun > intervalMs * 2) {
            return { late: true, expectedIntervalMs: intervalMs, sinceLastRun }
        }
    } catch {
        // Invalid schedule — flagged elsewhere
    }
    return null
}

export const cronLate: Agent = {
    name: 'cron-late',
    intervalSec: 5 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        try {
            const { db, sql } = await import('@plexo/db')
            const rows = await db.execute<JobRow>(sql`
                SELECT name, schedule, enabled, last_run_at, next_run_at
                FROM cron_jobs
                WHERE enabled = true
            `)
            const stale: { name: string; schedule: string; sinceLastRunSec: number }[] = []
            for (const j of rows) {
                const lateInfo = isLate(j)
                if (lateInfo) {
                    stale.push({
                        name: j.name,
                        schedule: j.schedule,
                        sinceLastRunSec: Math.round(lateInfo.sinceLastRun / 1000),
                    })
                }
            }
            if (stale.length === 0) return null
            return {
                agent: 'cron-late',
                at,
                severity: 'error',
                message: `${stale.length} cron job(s) overdue by 2x interval`,
                metadata: { stale },
            }
        } catch (err) {
            return {
                agent: 'cron-late',
                at,
                severity: 'warn',
                message: `Cron probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
