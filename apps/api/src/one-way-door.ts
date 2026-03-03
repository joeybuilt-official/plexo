/**
 * One-way door service.
 *
 * A "one-way door" operation is a destructive, irreversible, or externally
 * observable action that the agent cannot undo:
 *   - Database schema changes (migrations, DROP, ALTER)
 *   - Public API contract changes
 *   - Force-push / branch deletion
 *   - External API calls with side effects (email send, payment, DNS change)
 *   - File deletion
 *
 * Flow:
 * 1. Executor calls `requestApproval()` — returns a pending record ID
 * 2. An SSE event notifies the dashboard (and configured channels)
 * 3. User approves/rejects via dashboard button or channel reply
 * 4. Executor polls `isPending()` until approved, rejected, or timed out
 *
 * Storage: Redis with TTL. Key: `owd:{pendingId}`, value: JSON (PendingDecision)
 */
import { createClient, type RedisClientType } from 'redis'
import { randomBytes } from 'node:crypto'
import { logger } from './logger.js'

const OWD_TTL_SECONDS = 3600 // 1 hour — auto-reject if no response

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

// ── Request approval ──────────────────────────────────────────────────────────

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
    logger.info({ id, operation: params.operation, workspaceId: params.workspaceId }, 'One-way door pending')

    return record
}

// ── Check status ──────────────────────────────────────────────────────────────

export async function getDecision(id: string): Promise<PendingDecision | null> {
    const redis = await getRedis()
    const raw = await redis.get(key(id))
    if (!raw) return null
    return JSON.parse(raw) as PendingDecision
}

/**
 * Poll until decision is made or timeout. Used by the executor.
 * Executor should call `requestApproval` then `waitForDecision`.
 */
export async function waitForDecision(
    id: string,
    timeoutMs = 30 * 60 * 1000, // 30 minutes
): Promise<'approved' | 'rejected' | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    const POLL_INTERVAL_MS = 3000

    while (Date.now() < deadline) {
        const record = await getDecision(id)
        if (!record) return 'timeout' // TTL expired or deleted
        if (record.decision === 'approved') return 'approved'
        if (record.decision === 'rejected') return 'rejected'
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    return 'timeout'
}

// ── Resolve (approve/reject) — called by API route ───────────────────────────

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

    // Keep for another 10 minutes after decision so executor can pick it up
    await redis.setEx(key(id), 600, JSON.stringify(updated))
    logger.info({ id, decision, decidedBy }, 'One-way door resolved')

    return updated
}

// ── List pending for workspace ────────────────────────────────────────────────

export async function listPending(workspaceId: string): Promise<PendingDecision[]> {
    const redis = await getRedis()
    const keys = await redis.keys('owd:*')

    const decisions = await Promise.all(
        keys.map(async (k) => {
            const raw = await redis.get(k)
            return raw ? (JSON.parse(raw) as PendingDecision) : null
        }),
    )

    return decisions.filter(
        (d): d is PendingDecision =>
            d !== null && d.workspaceId === workspaceId && d.decision === 'pending',
    )
}
