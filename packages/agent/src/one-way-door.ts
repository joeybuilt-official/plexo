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
const ACK_POLL_INTERVAL_MS = 10_000
const ACK_TIMEOUT_MS = 60_000
const DEFAULT_ESCALATION_TIMEOUT_HOURS = 24

/**
 * Resolve the escalation timeout from workspace settings, env var, or default.
 * Priority: workspace settings → ESCALATION_TIMEOUT_HOURS env → 24h default.
 */
async function resolveEscalationTimeoutMs(workspaceId?: string): Promise<number> {
    // Try workspace settings
    if (workspaceId) {
        try {
            const { db, eq } = await import('@plexo/db')
            const { workspaces } = await import('@plexo/db')
            const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
                .where(eq(workspaces.id, workspaceId)).limit(1)
            const s = ws?.settings as Record<string, unknown> | undefined
            if (typeof s?.escalationTimeoutHours === 'number' && s.escalationTimeoutHours > 0) {
                return s.escalationTimeoutHours * 60 * 60 * 1000
            }
        } catch { /* non-fatal */ }
    }
    // Try env var
    const envHours = parseFloat(process.env.ESCALATION_TIMEOUT_HOURS ?? '')
    if (envHours > 0) return envHours * 60 * 60 * 1000
    return DEFAULT_ESCALATION_TIMEOUT_HOURS * 60 * 60 * 1000
}

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

/**
 * Poll for the SSE delivery acknowledgment key.
 * Written by SSE route when the owd.pending frame reaches the browser.
 */
async function pollForDeliveryAck(taskId: string): Promise<boolean> {
    const redis = await getRedis()
    const deadline = Date.now() + ACK_TIMEOUT_MS
    while (Date.now() < deadline) {
        const ack = await redis.get(`owd:${taskId}:ack`)
        if (ack) return true
        await new Promise((r) => setTimeout(r, ACK_POLL_INTERVAL_MS))
    }
    return false
}

/**
 * Attempt to deliver via secondary channel (Telegram, Slack) when SSE delivery fails.
 * Uses the eventBus to notify channel adapters. This is a best-effort fallback.
 */
async function triggerSecondaryChannel(taskId: string, payload: PendingDecision): Promise<void> {
    try {
        eventBus.emitSystem(TOPICS.OWD_PENDING, {
            ...payload,
            deliveryFallback: true,
            deliveryStatus: 'undelivered_via_sse',
        })
        logger.info({ taskId, id: payload.id }, 'OWD: triggered secondary channel delivery')
    } catch (err) {
        logger.warn({ err, taskId }, 'OWD: secondary channel delivery failed')
    }
}

export async function waitForDecision(
    id: string,
    timeoutMs?: number,
): Promise<'approved' | 'rejected' | 'timeout'> {
    // Resolve from workspace settings if no explicit timeout provided
    const record0 = await getDecision(id)
    const wsTimeout = !timeoutMs && record0?.workspaceId
        ? await resolveEscalationTimeoutMs(record0.workspaceId)
        : undefined
    const effectiveTimeout = timeoutMs ?? wsTimeout ?? (DEFAULT_ESCALATION_TIMEOUT_HOURS * 60 * 60 * 1000)
    const deadline = Date.now() + effectiveTimeout
    const POLL_MS = 3000

    // First check if SSE delivery was acknowledged
    const record = await getDecision(id)
    if (record) {
        const delivered = await pollForDeliveryAck(record.taskId)
        if (!delivered) {
            logger.warn({ id, taskId: record.taskId }, 'OWD: SSE delivery not acknowledged — triggering secondary channel')
            await triggerSecondaryChannel(record.taskId, record)
        }
    }

    while (Date.now() < deadline) {
        const current = await getDecision(id)
        if (!current) return 'timeout'
        if (current.decision === 'approved') return 'approved'
        if (current.decision === 'rejected') return 'rejected'
        await new Promise((r) => setTimeout(r, POLL_MS))
    }

    // Escalation timed out — cancel the OWD record
    if (record) {
        logger.info({ id, taskId: record.taskId }, 'OWD: escalation timed out after deadline')
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
