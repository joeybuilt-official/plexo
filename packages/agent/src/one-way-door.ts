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
 *
 * TTL note (Phase 4.5 decision): this surface drives task-level
 * `awaiting_approval` and defaults to 24h via workspace setting
 * `escalationTimeoutHours`. A long-running task may legitimately wait hours
 * for a human operator. Do NOT confuse with the per-tool-call escalation
 * runtime in `escalation/manager.ts` (default 5min via `DEFAULT_TTL_MS`),
 * which gates a single tool invocation inside an executor cycle and must
 * stay short. Both TTLs are correct for their respective lifetimes.
 */
import { createClient, type RedisClientType } from 'redis'
import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { eventBus, TOPICS } from './plugins/event-bus.js'

const logger = pino({ name: 'one-way-door' })

const DEFAULT_ESCALATION_TIMEOUT_HOURS = 24
/** TTL must exceed the max escalation timeout (default 24h) so the Redis
 *  key never expires while waitForDecision is still polling. Add 1h buffer. */
const OWD_TTL_SECONDS = (DEFAULT_ESCALATION_TIMEOUT_HOURS + 1) * 3600
const ACK_POLL_INTERVAL_MS = 10_000
const ACK_TIMEOUT_MS = 60_000

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
    // Check standing approvals before creating a pending record
    // SEC-016: Never auto-approve critical/high risk operations via standing approvals
    if (params.riskLevel === 'critical' || params.riskLevel === 'high') {
        logger.info({ operation: params.operation, riskLevel: params.riskLevel }, 'OWD skipping standing approvals — risk too high')
    } else try {
        const { db, eq, and } = await import('@plexo/db')
        const { standingApprovals } = await import('@plexo/db')
        const matches = await db.select().from(standingApprovals)
            .where(and(
                eq(standingApprovals.workspaceId, params.workspaceId),
                eq(standingApprovals.actionPattern, params.operation),
            ))
            .limit(1)
        if (matches.length > 0) {
            const sa = matches[0]!
            // Skip if expired
            if (!sa.expiresAt || sa.expiresAt > new Date()) {
                logger.info({ operation: params.operation, standingApprovalId: sa.id }, 'OWD auto-approved via standing approval')
                const id = randomBytes(12).toString('hex')
                return {
                    id,
                    ...params,
                    decision: 'approved',
                    createdAt: new Date().toISOString(),
                    decidedAt: new Date().toISOString(),
                    decidedBy: `standing-approval:${sa.id}`,
                }
            }
        }
    } catch (err) {
        logger.warn({ err }, 'OWD standing approval check failed, falling through to manual')
    }

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

/**
 * Periodic heartbeat interval for the `still_awaiting_approval` log emitted by
 * waitForDecision while a task is parked at the CONFIRM gate. 15 minutes is the
 * sweet spot between operator-visible cadence and log volume — a 24h wait
 * produces ~96 lines, low enough to not drown out adjacent events.
 */
const STILL_AWAITING_LOG_INTERVAL_MS = 15 * 60 * 1000

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
    const startedAt = Date.now()
    const deadline = startedAt + effectiveTimeout
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

    // Phase K (Item 15c): heartbeat while the operator hasn't decided. Cleared
    // in the finally below so resume / abort / timeout paths all stop emitting.
    const heartbeat = setInterval(() => {
        logger.info(
            {
                id,
                taskId: record?.taskId,
                workspaceId: record?.workspaceId,
                operation: record?.operation,
                waitingSinceMs: Date.now() - startedAt,
                event: 'still_awaiting_approval',
            },
            'OWD: still awaiting approval',
        )
    }, STILL_AWAITING_LOG_INTERVAL_MS)
    // Don't let the heartbeat keep the Node process alive past shutdown.
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    try {
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
    } finally {
        clearInterval(heartbeat)
    }
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
    eventBus.emitSystem(TOPICS.OWD_RESOLVED, updated)
    return updated
}

export async function listPending(workspaceId: string): Promise<PendingDecision[]> {
    const redis = await getRedis()
    const keys: string[] = []
    for await (const key of redis.scanIterator({ MATCH: 'owd:*', COUNT: 100 })) {
        keys.push(key)
    }

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
