// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Scheduled Dispatch — firing engine for cron_jobs.
 *
 * On each tick (every minute by default):
 *  1. Query enabled jobs with next_run_at <= now (or null = never initialised).
 *  2. For each due job, push a task to the queue with its configured task_type + context.
 *  3. Update last_run_at, last_run_status, consecutive_failures, and next_run_at.
 *
 * next_run_at is pre-computed so polling is a simple indexed range scan
 * rather than parsing every schedule on every tick.
 *
 * Internal jobs (Memory consolidation, RSI Monitor) that are managed by
 * cron.ts directly are skipped by the dispatch engine — they have no
 * task_context payload and are triggered through their own code paths.
 */

import { CronExpressionParser } from 'cron-parser'
import { db, eq, sql, lte, or, isNull, and } from '@plexo/db'
import { cronJobs } from '@plexo/db'
import type { TaskType } from '@plexo/db'
import { push } from '@plexo/queue'
import { logger } from './logger.js'

const TICK_INTERVAL_MS = 60_000 // 1 minute
const MAX_JOBS_PER_TICK = 50

/** Internal job names managed by cron.ts — skip from generic dispatch. */
const INTERNAL_JOB_NAMES = new Set(['Memory consolidation', 'RSI Monitor'])

// ── Next-run computation ──────────────────────────────────────────────────────

/**
 * Compute the next fire time after a given reference date.
 * Returns null if the expression is invalid or has no future date.
 */
function nextRunAfter(schedule: string, after: Date): Date | null {
    try {
        const expr = CronExpressionParser.parse(schedule, { currentDate: after })
        const next = expr.next()
        // CronDate.valueOf() returns a numeric timestamp; types omit this
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new Date((next as any).valueOf() as number)
    } catch {
        return null
    }
}

// ── Dispatch tick ─────────────────────────────────────────────────────────────

/**
 * Run one dispatch tick. Queries due jobs and fires them.
 * Safe to call concurrently — individual job updates are atomic.
 */
export async function dispatchDueJobs(): Promise<void> {
    const now = new Date()
    const nowIso = now.toISOString()

    let dueJobs: (typeof cronJobs.$inferSelect)[]
    try {
        // FUN-038: FOR UPDATE SKIP LOCKED prevents concurrent dispatch instances
        // from claiming the same jobs
        dueJobs = await db.execute<typeof cronJobs.$inferSelect>(sql`
            SELECT * FROM cron_jobs
            WHERE enabled = true
              AND (next_run_at IS NULL OR next_run_at <= ${nowIso})
            LIMIT ${MAX_JOBS_PER_TICK}
            FOR UPDATE SKIP LOCKED
        `) as unknown as (typeof cronJobs.$inferSelect)[]
    } catch (err) {
        logger.error({ err }, 'cron-dispatch: failed to query due jobs')
        return
    }

    for (const job of dueJobs) {
        // Raw SQL returns snake_case columns — normalise to camelCase
        const r = job as any
        const workspaceId: string = r.workspaceId ?? r.workspace_id
        const taskType: string = r.taskType ?? r.task_type ?? 'general'
        const taskContext: Record<string, unknown> = r.taskContext ?? r.task_context ?? {}
        const prevFailures: number = r.consecutiveFailures ?? r.consecutive_failures ?? 0

        // Skip internal jobs managed by cron.ts
        if (INTERNAL_JOB_NAMES.has(job.name)) {
            // Still need to advance next_run_at if it's null / stale
            const next = nextRunAfter(job.schedule, now)
            if (next) {
                await db
                    .update(cronJobs)
                    .set({ nextRunAt: next })
                    .where(eq(cronJobs.id, job.id))
                    .catch((err) => logger.warn({ err, jobId: job.id }, 'cron-dispatch: failed to advance internal job next_run_at'))
            }
            continue
        }

        let status: 'success' | 'failure' = 'success'
        try {
            await push({
                workspaceId,
                type: taskType as TaskType,
                source: 'cron',
                context: {
                    ...taskContext,
                    cronJobId: job.id,
                    cronJobName: job.name,
                    firedAt: now.toISOString(),
                },
            })
            logger.info({ jobId: job.id, name: job.name, workspaceId }, 'cron-dispatch: job fired')
        } catch (err) {
            logger.error({ err, jobId: job.id, name: job.name }, 'cron-dispatch: failed to push task for job')
            status = 'failure'
        }

        // Advance the job's state
        const next = nextRunAfter(job.schedule, now)
        const consecutiveFailures = status === 'failure'
            ? prevFailures + 1
            : 0

        await db
            .update(cronJobs)
            .set({
                lastRunAt: now,
                lastRunStatus: status,
                consecutiveFailures,
                nextRunAt: next,
            })
            .where(eq(cronJobs.id, job.id))
            .catch((err) => logger.warn({ err, jobId: job.id }, 'cron-dispatch: failed to update job state'))

        if (status === 'failure' && consecutiveFailures >= 3) {
            logger.warn(
                { jobId: job.id, name: job.name, consecutiveFailures },
                'cron-dispatch: job has 3+ consecutive failures — consider disabling',
            )
        }
    }
}

// ── Startup initialisation ────────────────────────────────────────────────────

/**
 * Initialise next_run_at for any jobs that have never fired.
 * Called once at startup before the first tick.
 */
async function initNextRunAt(): Promise<void> {
    let jobs: (typeof cronJobs.$inferSelect)[]
    try {
        jobs = await db
            .select()
            .from(cronJobs)
            .where(and(eq(cronJobs.enabled, true), isNull(cronJobs.nextRunAt)))
    } catch (err) {
        logger.warn({ err }, 'cron-dispatch: failed to query uninitialised jobs at startup')
        return
    }

    const now = new Date()
    for (const job of jobs) {
        const next = nextRunAfter(job.schedule, now)
        if (!next) continue
        await db
            .update(cronJobs)
            .set({ nextRunAt: next })
            .where(eq(cronJobs.id, job.id))
            .catch((err) => logger.warn({ err, jobId: job.id }, 'cron-dispatch: failed to set initial next_run_at'))
    }
}

/**
 * Start the scheduled dispatch engine.
 * Initialises next_run_at for all known jobs, then ticks every minute.
 * Returns a cleanup function that stops the interval.
 */
export function startCronDispatch(): () => void {
    void initNextRunAt().catch((err) => logger.warn({ err }, 'cron-dispatch: startup init failed (non-fatal)'))

    // Stagger first tick by 30s so it doesn't pile on top of agent loop startup
    const firstTick = setTimeout(() => {
        void dispatchDueJobs().catch((err) => logger.error({ err }, 'cron-dispatch: tick error'))
    }, 30_000)

    const interval = setInterval(() => {
        void dispatchDueJobs().catch((err) => logger.error({ err }, 'cron-dispatch: tick error'))
    }, TICK_INTERVAL_MS)

    logger.info({ tickIntervalMs: TICK_INTERVAL_MS }, 'cron-dispatch: started')

    return () => {
        clearTimeout(firstTick)
        clearInterval(interval)
        logger.info('cron-dispatch: stopped')
    }
}
