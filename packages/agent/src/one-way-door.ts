// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * One-Way Door service — agent package
 *
 * A one-way door is any irreversible or externally visible action:
 *   - Database schema changes (DROP, ALTER, migrations)
 *   - Public API contract changes
 *   - Force-push / branch deletion
 *   - External API calls with side effects (email, payment, DNS)
 *   - File deletion
 *
 * Flow:
 * 1. Executor calls requestApproval() — creates a pending record in Redis
 * 2. SSE route in the API pushes an event to the dashboard
 * 3. Operator approves/rejects via dashboard or channel reply
 * 4. Executor polls waitForDecision() until decision or timeout
 *
 * Storage: Redis, key `owd:{id}`, TTL 1 hour.
 */
import { createClient, type RedisClientType } from 'redis'
import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { eventBus, TOPICS } from './plugins/event-bus.js'

const logger = pino({ name: 'one-way-door' })

const OWD_TTL_SECONDS = 3600

export type OWDDecision = 'pending' | 'approved' | 'rejected'

export interface PendingDecision {
    id: string
    taskId: string
    workspaceId: string
    operation: string
    description: string
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    decision: OWDDecision
    createdAt: string
    decidedAt?: string
    decidedBy?: string
}

let _redis: RedisClientType | null = null

async function getRedis(): Promise<RedisClientType> {
    if (!_redis) {
        _redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType
        _redis.on('error', (err: Error) => logger.error({ err }, 'OWD Redis error'))
        await _redis.connect()
    }
    return _redis
}

function key(id: string): string {
    return `owd:${id}`
}

export async function requestApproval(params: {
    taskId: string
    workspaceId: string
    operation: string
    description: string
    riskLevel: PendingDecision['riskLevel']
}): Promise<PendingDecision> {
    const redis = await getRedis()
    const id = randomBytes(12).toString('hex')

    const record: PendingDecision = {
        id,
        ...params,
        decision: 'pending',
        createdAt: new Date().toISOString(),
    }

    await redis.setEx(key(id), OWD_TTL_SECONDS, JSON.stringify(record))
    logger.info({ id, operation: params.operation, workspaceId: params.workspaceId }, 'OWD pending')

    // Notify the dashboard in real time — API SSE layer subscribes to this topic
    eventBus.emitSystem(TOPICS.OWD_PENDING, record)

    return record
}

export async function getDecision(id: string): Promise<PendingDecision | null> {
    const redis = await getRedis()
    const raw = await redis.get(key(id))
    if (!raw) return null
    return JSON.parse(raw) as PendingDecision
}

export async function waitForDecision(
    id: string,
    timeoutMs = 30 * 60 * 1000,
): Promise<'approved' | 'rejected' | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    const POLL_MS = 3000

    while (Date.now() < deadline) {
        const record = await getDecision(id)
        if (!record) return 'timeout'
        if (record.decision === 'approved') return 'approved'
        if (record.decision === 'rejected') return 'rejected'
        await new Promise((r) => setTimeout(r, POLL_MS))
    }
    return 'timeout'
}

export async function resolveDecision(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
): Promise<PendingDecision | null> {
    const redis = await getRedis()
    const record = await getDecision(id)
    if (!record || record.decision !== 'pending') return null

    const updated: PendingDecision = {
        ...record,
        decision,
        decidedAt: new Date().toISOString(),
        decidedBy,
    }

    await redis.setEx(key(id), 600, JSON.stringify(updated))
    logger.info({ id, decision, decidedBy }, 'OWD resolved')
    return updated
}

export async function listPending(workspaceId: string): Promise<PendingDecision[]> {
    const redis = await getRedis()
    const keys = await redis.keys('owd:*')

    const decisions: Array<PendingDecision | null> = await Promise.all(
        keys.map(async (k: string) => {
            const raw = await redis.get(k)
            return raw ? (JSON.parse(raw) as PendingDecision) : null
        }),
    )

    return decisions.filter(
        (d): d is PendingDecision =>
            d !== null && d.workspaceId === workspaceId && d.decision === 'pending',
    )
}
