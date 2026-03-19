// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, sql } from '@plexo/db'
import { tasks } from '@plexo/db'
import { getRedis } from './redis-client.js'
import pino from 'pino'

const logger = pino({ name: 'parallel-executor' })
const PARALLEL_MAX_SLOTS = parseInt(process.env.PARALLEL_MAX_SLOTS ?? '3', 10)
const SLOT_TTL = 7200

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
        .where(eq(tasks.status, 'queued'))
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
