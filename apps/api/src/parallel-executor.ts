// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, sql } from '@plexo/db'
import { tasks } from '@plexo/db'
import { getRedis } from './redis-client.js'
import pino from 'pino'

const logger = pino({ name: 'parallel-executor' })
const PARALLEL_MAX_SLOTS = parseInt(process.env.PARALLEL_MAX_SLOTS ?? '3', 10)
const SLOT_TTL = 90 // seconds — heartbeat extends every 30s
export const HEARTBEAT_INTERVAL_MS = 30_000

export interface ParallelSlot {
    taskId: string
    resourceKey: string
    expiresAt: number
}

function getResourceKey(task: typeof tasks.$inferSelect): string {
    const ctx = task.context as Record<string, unknown> | null
    if (task.type === 'deployment') return `app_${(ctx?.app_uuid as string) ?? 'unknown'}`
    if (task.type === 'ops') return `ops_${(ctx?.target as string) ?? 'unknown'}`
    if (ctx?.repo) return `repo_${ctx.repo}`
    return `task_${task.id}`
}

const MAX_ATTEMPTS = 3

/** Backoff delays in seconds: 2m after 1st failure, 5m after 2nd, 1h after 3rd (then blocked).
 *  First retry raised from 30s to 120s — during a typical 1-5 min provider outage,
 *  30s was too short (fails immediately, burns attempt 2). */
const BACKOFF_DELAYS_S = [120, 300, 3600]

/**
 * When a slot expires (process died, no heartbeat), requeue the task or fail it.
 * Increments attempt_count. If >= MAX_ATTEMPTS, marks the task as blocked.
 * Otherwise, sets retry_after with exponential backoff so the task isn't
 * immediately reclaimed.
 */
async function handleExpiredSlot(taskId: string): Promise<void> {
    try {
        // First, get current attempt count to compute backoff
        const current = await db.execute<{ attempt_count: number }>(sql`
            SELECT COALESCE(attempt_count, 0) AS attempt_count FROM tasks WHERE id = ${taskId} AND status = 'running'
        `)
        if (current.length === 0) return

        const nextAttempt = (current[0]!.attempt_count ?? 0) + 1
        const backoffSeconds = BACKOFF_DELAYS_S[Math.min(nextAttempt - 1, BACKOFF_DELAYS_S.length - 1)]!

        const result = await db.execute<{ id: string; attempt_count: number }>(sql`
            UPDATE tasks
            SET attempt_count = ${nextAttempt},
                status = CASE
                    WHEN ${nextAttempt} >= ${MAX_ATTEMPTS} THEN 'blocked'::task_status
                    ELSE 'queued'::task_status
                END,
                outcome_summary = CASE
                    WHEN ${nextAttempt} >= ${MAX_ATTEMPTS}
                    THEN 'Failed after ' || ${nextAttempt} || ' attempts (slot expired — process likely crashed)'
                    ELSE outcome_summary
                END,
                claimed_at = NULL,
                retry_after = CASE
                    WHEN ${nextAttempt} < ${MAX_ATTEMPTS}
                    THEN NOW() + (${backoffSeconds} || ' seconds')::interval
                    ELSE NULL
                END
            WHERE id = ${taskId} AND status = 'running'
            RETURNING id, attempt_count
        `)
        if (result.length > 0) {
            const row = result[0]!
            const newStatus = (row.attempt_count ?? 0) >= MAX_ATTEMPTS ? 'blocked' : 'queued'
            logger.info({ event: 'task.lifecycle', taskId, from: 'running', to: newStatus, attemptCount: row.attempt_count, backoffSeconds, reason: 'slot_expired' }, 'lifecycle')
        }
    } catch (err) {
        logger.warn({ err, taskId }, 'handleExpiredSlot failed — non-fatal')
    }
}

export async function claimBatch(): Promise<(typeof tasks.$inferSelect)[]> {
    const redis = await getRedis()
    const rawSlots = await redis.hGetAll('zeroclaw:parallel:slots')
    const activeSlots: ParallelSlot[] = []
    
    const now = Date.now() / 1000
    for (const [taskId, dataBase] of Object.entries(rawSlots)) {
        try {
            const data = JSON.parse(dataBase)
            if (data.expiresAt < now) {
                await redis.hDel('zeroclaw:parallel:slots', taskId)
                // Auto-requeue or fail the task that held this expired slot
                await handleExpiredSlot(taskId)
            } else {
                activeSlots.push(data)
            }
        } catch {
            // Corrupted slot data — evict it
            await redis.hDel('zeroclaw:parallel:slots', taskId)
        }
    }

    if (activeSlots.length >= PARALLEL_MAX_SLOTS) {
        return []
    }

    const queuedTasks = await db.select().from(tasks)
        .where(sql`${tasks.status} = 'queued' AND (${tasks.retryAfter} IS NULL OR ${tasks.retryAfter} <= NOW())`)
        .orderBy(sql`${tasks.priority} ASC`, sql`${tasks.createdAt} ASC`)
        .limit(20)

    const claimedTasks: (typeof tasks.$inferSelect)[] = []
    const availableSlots = PARALLEL_MAX_SLOTS - activeSlots.length
    const claimedResources = new Set(activeSlots.map(s => s.resourceKey))

    for (const task of queuedTasks) {
        if (claimedTasks.length >= availableSlots) break

        const rKey = getResourceKey(task)
        // Deployment tasks have strict sequential per project invariant
        // Git tasks have strict repo invariant
        if (rKey.startsWith('task_') || !claimedResources.has(rKey)) {
            // Atomic CAS: only claim if still queued (prevents double-claim races)
            const result = await db.execute<typeof tasks.$inferSelect>(sql`
                UPDATE tasks
                SET status = 'claimed', claimed_at = NOW()
                WHERE id = ${task.id} AND status = 'queued'
                RETURNING *
            `)
            if (result.length > 0 && result[0]) {
                claimedTasks.push(result[0])
                claimedResources.add(rKey)
                const slot: ParallelSlot = {
                    taskId: task.id,
                    resourceKey: rKey,
                    expiresAt: now + SLOT_TTL
                }
                await redis.hSet('zeroclaw:parallel:slots', task.id, JSON.stringify(slot))
            }
        }
    }
    
    return claimedTasks
}

export async function releaseSlot(taskId: string): Promise<void> {
    const redis = await getRedis()
    await redis.hDel('zeroclaw:parallel:slots', taskId)
}

/**
 * Heartbeat: extend a slot's TTL by SLOT_TTL seconds from now.
 * Called every HEARTBEAT_INTERVAL_MS from the task runner.
 * If the process dies, the interval stops, and the slot expires in ≤ SLOT_TTL seconds.
 */
export async function extendSlot(taskId: string): Promise<void> {
    const redis = await getRedis()
    const raw = await redis.hGet('zeroclaw:parallel:slots', taskId)
    if (!raw) return
    try {
        const slot = JSON.parse(raw) as ParallelSlot
        slot.expiresAt = Date.now() / 1000 + SLOT_TTL
        await redis.hSet('zeroclaw:parallel:slots', taskId, JSON.stringify(slot))
    } catch {
        // Corrupted — remove
        await redis.hDel('zeroclaw:parallel:slots', taskId)
    }
}

export async function getParallelStatus() {
    const redis = await getRedis()
    const rawSlots = await redis.hGetAll('zeroclaw:parallel:slots')
    const activeSlots: ParallelSlot[] = []
    const now = Date.now() / 1000
    
    for (const [taskId, dataBase] of Object.entries(rawSlots)) {
        try {
            const data = JSON.parse(dataBase)
            if (data.expiresAt >= now) {
                activeSlots.push(data)
            }
        } catch { /* corrupted JSON — skip slot */ }
    }
    return { slots: activeSlots, maxSlots: PARALLEL_MAX_SLOTS }
}

export async function clearAllSlots(): Promise<void> {
    const redis = await getRedis()
    await redis.del('zeroclaw:parallel:slots')
}
