// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { syncModelKnowledge } from '@plexo/agent/providers/knowledge'
import { runSelfImprovementCycle } from '@plexo/agent/memory/self-improvement'
import { sql, eq, and, inArray } from 'drizzle-orm'
import { db } from '@plexo/db'
import { cronJobs, artifactVersions, artifacts, workspaceMembers } from '@plexo/db'
import { mirrorAuthUserToPublic } from '@plexo/db/auth/config'
import { logger } from './logger.js'
import { loadWorkspaceAISettings } from './agent-loop.js'
import { runWeeklyDigest } from './analytics/digest-worker.js'
import { deleteByPrefix } from '@plexo/storage'
import { flushRetrievalCounts, decayConfidence } from './cron/confidence-lifecycle.js'
import { pollAllGmailChannels } from './lib/gmail-poll.js'
import { runAttachmentScanTick } from './lib/attachment-scan-worker.js'
import { getAllStats } from '@plexo/agent/providers/router-v2'
import { getSchemaRelaxedStats } from '@plexo/agent/providers/call-model'
import { getLaneStats } from '@plexo/agent/providers/router-v2'
import { flushOpsAlerts, evaluateSloBreaches, sloThresholdsFromEnv, recordSloBreachForAlert } from './ops-alerts.js'
import { INTERNAL_JOB_NAMES } from './cron-internal-jobs.js'

/** Update last_run_at + last_run_status for internal cron jobs so the
 *  dashboard doesn't show them as stale / never-run. */
async function markInternalJobRun(name: string, status: 'success' | 'failure'): Promise<void> {
    try {
        await db
            .update(cronJobs)
            .set({ lastRunAt: new Date(), lastRunStatus: status, consecutiveFailures: status === 'success' ? 0 : sql`consecutive_failures + 1` })
            .where(and(eq(cronJobs.name, name), eq(cronJobs.enabled, true)))
    } catch (err) {
        logger.warn({ err, name }, 'Failed to mark internal cron job run (non-fatal)')
    }
}

export async function runCronJobs() {
    logger.info('Starting scheduled jobs...')
    try {
        await syncModelKnowledge()
        logger.info('Scheduled jobs completed successfully.')
    } catch (err) {
        logger.error({ err }, 'Scheduled jobs failed.')
    }
}

/**
 * Memory consolidation — runs the self-improvement cycle for all workspaces.
 * Called automatically every N hours (see scheduleMemoryConsolidation below)
 * and visible as a cron job in the UI per workspace.
 */
export async function runMemoryConsolidation(): Promise<void> {
    logger.info('Memory consolidation: starting')

    let workspaceIds: string[] = []
    try {
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 50
        `)
        workspaceIds = rows.map((r) => r.id)
    } catch (err) {
        logger.error({ err }, 'Memory consolidation: failed to list workspaces')
        return
    }

    let anyFailure = false
    for (const workspaceId of workspaceIds) {
        try {
            const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
            const result = await runSelfImprovementCycle({ workspaceId, aiSettings: aiSettings ?? undefined })
            logger.info({ workspaceId, count: result.proposals }, 'Memory consolidation: cycle complete')
        } catch (err) {
            anyFailure = true
            logger.warn({ err, workspaceId }, 'Memory consolidation: workspace cycle failed (non-fatal)')
        }
    }

    await markInternalJobRun('Memory consolidation', anyFailure ? 'failure' : 'success')
    logger.info('Memory consolidation: all workspaces processed')
}

/**
 * FUN-034: Artifact cleanup — delete artifacts older than 90 days.
 * Removes S3 objects by workspace/task prefix, then soft-deletes DB rows.
 * Runs daily via the in-process scheduler.
 */
export async function runArtifactCleanup(): Promise<void> {
    logger.info('Artifact cleanup: starting')
    try {
        // Find artifacts older than 90 days
        const staleArtifacts = await db.execute<{
            id: string
            workspace_id: string
            task_id: string | null
            project_id: string | null
        }>(sql`
            SELECT id, workspace_id, task_id, project_id
            FROM artifacts
            WHERE created_at < NOW() - INTERVAL '90 days'
            LIMIT 500
        `)

        if (staleArtifacts.length === 0) {
            logger.info('Artifact cleanup: nothing to clean')
            await markInternalJobRun('Artifact cleanup', 'success')
            return
        }

        let cleaned = 0
        const cleanedIds: string[] = []
        for (const artifact of staleArtifacts) {
            try {
                const prefix = `${artifact.workspace_id}/${artifact.task_id ?? artifact.project_id ?? 'orphan'}/`
                await deleteByPrefix(prefix)
                cleanedIds.push(artifact.id)
                cleaned++
            } catch (err) {
                logger.warn({ err, artifactId: artifact.id }, 'Artifact cleanup: failed to clean S3 for artifact — continuing')
            }
        }
        if (cleanedIds.length > 0) {
            await db.delete(artifactVersions).where(inArray(artifactVersions.artifactId, cleanedIds))
            await db.delete(artifacts).where(inArray(artifacts.id, cleanedIds))
        }

        logger.info({ cleaned, total: staleArtifacts.length }, 'Artifact cleanup: complete')
        await markInternalJobRun('Artifact cleanup', 'success')
    } catch (err) {
        logger.error({ err }, 'Artifact cleanup: failed')
        await markInternalJobRun('Artifact cleanup', 'failure')
    }
}

/**
 * Data retention cleanup — delete old rows from append-only log tables.
 * Controlled by DATA_RETENTION_DAYS env var (default 90, 0 = disabled).
 */
async function runDataRetention(): Promise<void> {
    const days = parseInt(process.env.DATA_RETENTION_DAYS ?? '90', 10)
    if (days <= 0) {
        logger.info('Data retention disabled (DATA_RETENTION_DAYS <= 0)')
        return
    }

    // Delete old session_logs
    const sessionResult = await db.execute(sql`
        DELETE FROM session_logs WHERE created_at < NOW() - INTERVAL '1 day' * ${days}
    `)

    // Delete old work_ledger entries
    const ledgerResult = await db.execute(sql`
        DELETE FROM work_ledger WHERE completed_at < NOW() - INTERVAL '1 day' * ${days}
    `)

    // Prune PROCESSED node_events (Round-5 Phase 1). These are append-only
    // operational federation/telemetry events with no value once processed
    // (e.g. high-volume ext.fonto.asset.* dropped as unhandled). Unprocessed
    // rows are pending work and are NEVER deleted. Shorter, independent window
    // (NODE_EVENTS_RETENTION_DAYS, default 7, 0 = disabled) so it doesn't couple
    // to the 90-day log retention.
    const neDays = parseInt(process.env.NODE_EVENTS_RETENTION_DAYS ?? '7', 10)
    let nodeEventsDeleted = 0
    if (neDays > 0) {
        const neResult = await db.execute(sql`
            DELETE FROM node_events WHERE processed = true AND created_at < NOW() - INTERVAL '1 day' * ${neDays}
        `)
        nodeEventsDeleted = neResult.length ?? 0
    }

    // Prune routing_events + shadow_extraction_results (Round-5 Phase 3).
    // Both are append-only telemetry/eval streams; bounded here so neither
    // becomes the next unbounded node_events (ADR 0001 pre-mortem #3). Their own
    // window (ROUTING_EVENTS_RETENTION_DAYS, default 30, 0 = disabled).
    const reDays = parseInt(process.env.ROUTING_EVENTS_RETENTION_DAYS ?? '30', 10)
    let routingEventsDeleted = 0
    let shadowResultsDeleted = 0
    if (reDays > 0) {
        const reResult = await db.execute(sql`
            DELETE FROM routing_events WHERE created_at < NOW() - INTERVAL '1 day' * ${reDays}
        `)
        routingEventsDeleted = reResult.length ?? 0
        const seResult = await db.execute(sql`
            DELETE FROM shadow_extraction_results WHERE created_at < NOW() - INTERVAL '1 day' * ${reDays}
        `)
        shadowResultsDeleted = seResult.length ?? 0
    }

    logger.info({
        sessionLogsDeleted: sessionResult.length ?? 0,
        workLedgerDeleted: ledgerResult.length ?? 0,
        nodeEventsDeleted,
        routingEventsDeleted,
        shadowResultsDeleted,
        retentionDays: days,
        nodeEventsRetentionDays: neDays,
        routingEventsRetentionDays: reDays,
    }, 'Data retention cleanup complete')
}

/**
 * Phase 4 (stabilization) — persist router-v2 call stats.
 *
 * Router-v2 stats live in-memory per process and reset on every deploy. This
 * snapshots the current state of every live bucket into `router_v2_stats` on a
 * fixed cadence so observability survives restarts and multiple API instances'
 * views can be aggregated at read time. Append-only; never writes on the hot
 * path (one batched insert per cron tick).
 */
export async function runRouterStatsSnapshot(): Promise<void> {
    // Surface schema-relaxation telemetry alongside the router snapshot so the
    // "how often the structured-output safety net fires" counter is observable.
    logger.info({ schemaRelaxed: getSchemaRelaxedStats() }, 'Router stats snapshot: schema_relaxed counters')
    logger.info({ lane: getLaneStats() }, 'Router stats snapshot: background-lane counters')

    const entries = getAllStats()
    if (entries.length === 0) {
        logger.info('Router stats snapshot: no live buckets — skipping')
        return
    }

    const snapshotAt = new Date()
    const rows = entries.map(({ key, stats }) => sql`(
        ${key.workspaceId ?? null},
        ${key.provider},
        ${key.model},
        ${key.taskType},
        ${stats.sampleCount},
        ${stats.successRate},
        ${stats.latencyP50Ms},
        ${stats.latencyP95Ms},
        ${stats.recentFailurePenalty},
        ${stats.cooldownEndAt > 0 ? new Date(stats.cooldownEndAt).toISOString() : null},
        ${snapshotAt.toISOString()}
    )`)

    await db.execute(sql`
        INSERT INTO router_v2_stats
            (workspace_id, provider, model, task_type, sample_count, success_rate,
             latency_p50_ms, latency_p95_ms, recent_failure_penalty, cooldown_end_at, snapshot_at)
        VALUES ${sql.join(rows, sql`, `)}
    `)
    logger.info({ count: entries.length }, 'Router stats snapshot: persisted')

    // Round-5 Phase 9: SLO breach detection on the same in-memory buckets we
    // just snapshotted. Breaches are enqueued into the batched ops-alerts flush
    // (one Telegram summary per tick). Env-gated; PLEXO_SLO_MIN_SUCCESS=0 = off.
    const slo = sloThresholdsFromEnv()
    if (slo) {
        const breaches = evaluateSloBreaches(
            entries.map(({ key, stats }) => ({
                provider: key.provider,
                model: key.model,
                taskType: key.taskType,
                successRate: stats.successRate,
                sampleCount: stats.sampleCount,
                latencyP95Ms: stats.latencyP95Ms,
            })),
            slo,
        )
        for (const b of breaches) recordSloBreachForAlert(b)
        if (breaches.length > 0) {
            logger.warn({ breaches: breaches.length, minSuccess: slo.minSuccess, minSamples: slo.minSamples }, 'Router stats snapshot: SLO breaches enqueued for ops alert')
        }
    }
}

/**
 * FUN-039: Crash-resilient internal scheduler.
 *
 * Instead of bare setInterval (which resets on process restart and loses
 * elapsed time), we check each job's last_run_at from the DB. If a job
 * is overdue (e.g. process was down for 5h of a 6h interval), it fires
 * immediately on startup.
 *
 * The cron-dispatch engine still skips INTERNAL_JOB_NAMES (they call
 * functions directly, not queue tasks). This function owns execution.
 */

/** Internal job definitions: name, interval, and handler function */
const INTERNAL_JOBS: Array<{
    name: string
    schedule: string      // cron expression (stored in DB for dashboard display)
    intervalMs: number    // fire if last_run_at older than this
    handler: () => Promise<void>
}> = [
    {
        name: 'Memory consolidation',
        schedule: '0 */6 * * *',
        intervalMs: 6 * 60 * 60 * 1000,
        handler: runMemoryConsolidation,
    },
    {
        name: 'Weekly digest',
        schedule: '0 8 * * 1',
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        handler: async () => { await runWeeklyDigest() },
    },
    {
        name: 'Artifact cleanup',
        schedule: '0 3 * * *',
        intervalMs: 24 * 60 * 60 * 1000,
        handler: runArtifactCleanup,
    },
    {
        // Phase 4 (stabilization) — persist router-v2 stats so observability
        // survives deploys. Snapshot the in-memory buckets every 30 min.
        name: 'Router stats snapshot',
        schedule: '*/30 * * * *',
        intervalMs: 30 * 60 * 1000,
        handler: runRouterStatsSnapshot,
    },
    {
        // Phase 4 (stabilization) — batched operator alert for provider
        // unreliability + failed canaries. Sends one Telegram summary per tick.
        name: 'Ops alerts flush',
        schedule: '*/15 * * * *',
        intervalMs: 15 * 60 * 1000,
        handler: flushOpsAlerts,
    },
    {
        name: 'Orphan user cleanup',
        schedule: '0 4 * * 0',
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        handler: async () => {
            const count = await reconcileOrphanedUsers()
            await markInternalJobRun('Orphan user cleanup', 'success')
            logger.info({ count }, 'FUN-040: orphan user cleanup complete')
        },
    },
    {
        name: '__internal_data_retention',
        schedule: '0 3 * * 0',   // Sunday 3am UTC
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        handler: runDataRetention,
    },
    {
        // Phase 7 — tier cooldown: hot→active (7d stale), active→cold (90d stale).
        name: '__internal_flush_retrieval_counts',
        schedule: '*/5 * * * *',
        intervalMs: 5 * 60 * 1000,
        handler: flushRetrievalCounts,
    },
    {
        // Phase 7 — weekly confidence decay ×0.9 for non-anchored entries.
        name: '__internal_decay_confidence',
        schedule: '0 3 * * 0',
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        handler: decayConfidence,
    },
    {
        // Stabilization monitoring agents — Romeo Backlog A.
        // Drives all 10 agents on a 5-minute cadence. Each agent has its
        // own internal threshold; this just ensures they all get woken up.
        name: '__internal_stabilization_agents',
        schedule: '*/5 * * * *',
        intervalMs: 5 * 60 * 1000,
        handler: async () => {
            const { runMonitoringAgents } = await import('./stabilization/agents/index.js')
            const results = await runMonitoringAgents()
            const broken = results.filter((r) => !r.healthy).length
            if (broken > 0) {
                logger.warn({ broken, total: results.length }, 'Stabilization agents reported issues')
            } else {
                logger.info({ total: results.length }, 'Stabilization agents all healthy')
            }
        },
    },
    {
        // L3 Stage 2 — Gmail-as-channel inbound poller.
        // No-op stub: actual polling runs in the dedicated setInterval below in
        // scheduleMemoryConsolidation() (the in-process overdue-checker fires
        // only every 10 min, too coarse for inbound mail). The dashboard sees
        // last_run_at via markInternalJobRun in the setInterval handler.
        name: 'gmail-poll',
        schedule: '*/1 * * * *',
        intervalMs: 60 * 1000,
        handler: async () => { /* see dedicated setInterval below */ },
    },
]

/**
 * Upsert internal cron jobs into the DB so they appear in the dashboard
 * and their last_run_at survives restarts.
 */
async function ensureInternalCronJobs(): Promise<void> {
    const [ws] = await db.execute<{ id: string }>(sql`
        SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1
    `)
    if (!ws) {
        logger.warn('FUN-039: No workspaces exist — skipping internal cron job upsert')
        return
    }

    for (const job of INTERNAL_JOBS) {
        try {
            const [existing] = await db.select({ id: cronJobs.id })
                .from(cronJobs).where(eq(cronJobs.name, job.name)).limit(1)
            if (!existing) {
                await db.execute(sql`
                    INSERT INTO cron_jobs (workspace_id, name, schedule, enabled, task_type, task_context)
                    VALUES (${ws.id}::uuid, ${job.name}, ${job.schedule}, true, 'general', '{}')
                `)
                logger.info({ name: job.name }, 'FUN-039: internal cron job created')
            } else {
                await db.update(cronJobs)
                    .set({ schedule: job.schedule })
                    .where(eq(cronJobs.id, existing.id))
            }
        } catch (err) {
            logger.warn({ err, name: job.name }, 'FUN-039: failed to upsert internal cron job')
        }
    }
}

/**
 * Check each internal job's last_run_at and fire if overdue.
 */
async function runOverdueInternalJobs(): Promise<void> {
    for (const job of INTERNAL_JOBS) {
        try {
            const [row] = await db.select({ lastRunAt: cronJobs.lastRunAt })
                .from(cronJobs).where(eq(cronJobs.name, job.name)).limit(1)

            const lastRun = row?.lastRunAt ? row.lastRunAt.getTime() : 0
            const elapsed = Date.now() - lastRun

            if (elapsed >= job.intervalMs) {
                logger.info({ name: job.name, elapsedMs: elapsed }, 'FUN-039: internal job overdue — firing')
                try {
                    await job.handler()
                    await markInternalJobRun(job.name, 'success')
                } catch (err) {
                    await markInternalJobRun(job.name, 'failure')
                    logger.error({ err, name: job.name }, 'FUN-039: internal job failed')
                }
            }
        } catch (err) {
            logger.warn({ err, name: job.name }, 'FUN-039: failed to check internal job status')
        }
    }
}

/**
 * Historical name; this is the de facto startCrons() entry point.
 * Registers all internal crons: memory consolidation, overdue jobs,
 * Gmail polling, attachment scan worker.
 */
export function scheduleMemoryConsolidation(): void {
    if (process.env.SELF_IMPROVEMENT_ENABLED === 'false' || process.env.PLEXO_DISABLE_CRONS === '1') {
        logger.warn('Memory consolidation / internal cron scheduling disabled via SELF_IMPROVEMENT_ENABLED=false or PLEXO_DISABLE_CRONS=1')
        return
    }
    const CHECK_INTERVAL = 10 * 60 * 1000 // check every 10 minutes

    // Drift guard: every internal function-handler job MUST be in the
    // cron-dispatch skip set, else cron-dispatch queues empty agent tasks for it.
    for (const job of INTERNAL_JOBS) {
        if (!INTERNAL_JOB_NAMES.has(job.name)) {
            logger.error({ name: job.name }, 'cron: INTERNAL_JOBS name missing from INTERNAL_JOB_NAMES (cron-internal-jobs.ts) — cron-dispatch will queue empty tasks for it')
        }
    }

    // Upsert internal job rows on startup
    void ensureInternalCronJobs().catch(err =>
        logger.warn({ err }, 'FUN-039: failed to upsert internal cron jobs'))

    // First check after 2 min (DB warmup), then every 10 min
    setTimeout(() => {
        void runOverdueInternalJobs()
        setInterval(() => { void runOverdueInternalJobs() }, CHECK_INTERVAL)
    }, 2 * 60 * 1000)

    // L3 Stage 2 — dedicated 1-minute Gmail poll loop. The shared
    // INTERNAL_JOBS overdue-check fires only every 10 min, which is too
    // coarse for inbound mail. Per-cycle jitter (0-30s) is applied inside
    // the handler to spread load across instances.
    const GMAIL_POLL_INTERVAL = 60 * 1000
    setTimeout(() => {
        const tick = async (): Promise<void> => {
            try {
                const jitter = Math.floor(Math.random() * 30_000)
                await new Promise((r) => setTimeout(r, jitter))
                await pollAllGmailChannels()
                await markInternalJobRun('gmail-poll', 'success')
            } catch (err) {
                await markInternalJobRun('gmail-poll', 'failure')
                logger.error({ err }, 'gmail-poll tick failed')
            }
        }
        void tick()
        setInterval(() => { void tick() }, GMAIL_POLL_INTERVAL)
    }, 90 * 1000)

    // Phase N+1 (ADR 0012) — clamd attachment scan worker.
    const ATTACHMENT_SCAN_INTERVAL = 5000
    setInterval(() => { void runAttachmentScanTick() }, ATTACHMENT_SCAN_INTERVAL)
    logger.info({ intervalMs: ATTACHMENT_SCAN_INTERVAL }, 'attachment-scan-worker registered')
}

/**
 * FUN-040: Reconcile orphaned user references.
 * Two passes:
 *  1. DELETE workspace_members whose user_id no longer exists in auth.user.
 *  2. INSERT (Phase H+1) missing public.users rows for auth.user accounts
 *     that signed up but never created a workspace — closes the cold-path
 *     gap left by Phase H (Better Auth post-create hook + workspace POST
 *     backstop only cover the hot path).
 */
export async function reconcileOrphanedUsers(): Promise<number> {
    logger.info('FUN-040: reconciling orphaned user references')
    let count = 0
    try {
        // Find workspace members whose userId no longer exists in auth.user
        // via the FDW. This query is safe — it only reads the auth table.
        const orphans = await db.execute(sql`
            DELETE FROM workspace_members wm
            WHERE NOT EXISTS (
                SELECT 1 FROM auth.user au WHERE au.id = wm.user_id
            )
            RETURNING wm.user_id, wm.workspace_id
        `)
        count = (orphans as { rowCount?: number }).rowCount ?? 0
        if (count > 0) {
            logger.warn({ count }, 'FUN-040: removed orphaned workspace memberships')
        } else {
            logger.info('FUN-040: no orphaned user references found')
        }
    } catch (err) {
        // Non-fatal — FDW may not be configured in all deployments
        logger.warn({ err }, 'FUN-040: orphan reconciliation failed (FDW may not be available)')
    }

    // Phase H+1: backfill missing public.users from auth.user. Closes the
    // residual gap where signup → idle (no workspace ever created) leaves
    // public.users empty if the post-commit databaseHooks callback crashed.
    try {
        const missing = await db.execute<{
            id: string
            name: string
            email: string
            emailVerified: boolean
            createdAt: Date
            updatedAt: Date
            image: string | null
        }>(sql`
            SELECT au.id, au.name, au.email, au."emailVerified",
                   au."createdAt", au."updatedAt", au.image
            FROM auth.user au
            WHERE NOT EXISTS (
                SELECT 1 FROM public.users u WHERE u.id = au.id::uuid
            )
        `)
        let backfilled = 0
        for (const u of missing) {
            try {
                await mirrorAuthUserToPublic(u, db)
                backfilled++
            } catch (err) {
                logger.warn({ err, userId: u.id }, 'FUN-040: failed to backfill orphan auth.user')
            }
        }
        if (backfilled > 0) {
            logger.info({ backfilled }, 'FUN-040: backfilled missing public.users rows')
        }
    } catch (err) {
        logger.warn({ err }, 'FUN-040: backfill query failed (FDW may not be available)')
    }

    return count
}

/**
 * Domain Mastery maintenance — weekly cron for all workspaces.
 * Refreshes domain metrics, decays stale rules, quarantines poor rules,
 * and checks kill switches. Feature-flagged per workspace (ADR-004).
 */
export async function runDomainMasteryMaintenance(): Promise<void> {
    logger.info('Domain mastery maintenance: starting')

    let workspaceIds: string[] = []
    try {
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 50
        `)
        workspaceIds = rows.map((r) => r.id)
    } catch (err) {
        logger.error({ err }, 'Domain mastery: failed to list workspaces')
        return
    }

    for (const workspaceId of workspaceIds) {
        try {
            // Check if domain mastery is enabled for this workspace
            const { isDomainMasteryEnabled } = await import('@plexo/agent/domain-mastery')
            if (!(await isDomainMasteryEnabled(workspaceId))) continue

            const { refreshDomainMetrics, decayStaleRules, quarantinePoorRules, checkKillSwitch } =
                await import('@plexo/agent/domain-mastery/credit-assignment')

            // Check kill switch first — if triggered, skip learning maintenance
            const killed = await checkKillSwitch(workspaceId)
            if (killed) {
                logger.info({ workspaceId }, 'Domain mastery: kill switch active — skipping maintenance')
                continue
            }

            await refreshDomainMetrics(workspaceId)
            await decayStaleRules(workspaceId)
            await quarantinePoorRules(workspaceId)

            logger.info({ workspaceId }, 'Domain mastery: maintenance complete')
        } catch (err) {
            logger.warn({ err, workspaceId }, 'Domain mastery: workspace maintenance failed (non-fatal)')
        }
    }

    await markInternalJobRun('Domain mastery', 'success')
    logger.info('Domain mastery maintenance: all workspaces processed')
}

// If run directly:
if (import.meta.url === `file://${process.argv[1]}`) {
    runCronJobs().catch(console.error).then(() => process.exit(0))
}
