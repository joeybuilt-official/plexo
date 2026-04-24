// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 8 — Escalation Runtime manager.
 *
 * Pauses a tool invocation and asks a human whether to proceed. The
 * executor calls `requestEscalation` before invoking a flagged tool; the
 * returned promise resolves once the user approves or rejects the request
 * (or when the TTL elapses, whichever comes first).
 *
 * Persistence model:
 *   - One row per request in `escalation_requests`.
 *   - Row status transitions pending → approved | rejected | timeout.
 *   - Decisions update the DB row AND resolve the in-memory promise.
 *
 * Process-restart recovery:
 *   - On module load, sweep the DB for any `status = pending` rows whose
 *     `expires_at` has already passed and mark them `timeout`. This keeps
 *     the runtime honest when a container restarts mid-escalation.
 *   - Pending rows that have NOT expired are left alone. Their original
 *     waiter is gone, but the row remains so a new inbox view can still
 *     render them and a later decision can still be recorded; the
 *     executor call that originally requested them is already dead.
 *
 * Background sweeper:
 *   - Runs every 30s.
 *   - Marks any pending row past `expires_at` as `timeout`.
 *   - Resolves any still-registered in-memory waiter as timeout.
 */
import pino from 'pino'
import { db, and, eq, lt } from '@plexo/db'
import { escalationRequests } from '@plexo/db'
import { eventBus, TOPICS } from '../plugins/event-bus.js'
import { logAuditEntry } from '../audit.js'

const logger = pino({ name: 'escalation-manager' })

export type EscalationStatus = 'pending' | 'approved' | 'rejected' | 'timeout'

export interface EscalationRequestInput {
    workspaceId: string
    sessionId: string
    agentId?: string
    toolName: string
    payload: unknown
    reason?: string
    /** Milliseconds until expiry. Defaults to 5 minutes. */
    ttlMs?: number
}

export interface EscalationDecision {
    id: string
    status: Exclude<EscalationStatus, 'pending'>
    decidedBy?: string
    decisionNote?: string
    /** For 'timeout' this is the ISO of when the sweeper gave up. */
    decidedAt: string
    /** For 'rejected' the agent receives this back as a reason. */
    reason?: string
}

interface Pending {
    resolve: (decision: EscalationDecision) => void
    timer: ReturnType<typeof setTimeout>
    workspaceId: string
    sessionId: string
    toolName: string
}

const DEFAULT_TTL_MS = 5 * 60 * 1000
const SWEEPER_INTERVAL_MS = 30 * 1000

// In-memory waiter registry keyed by escalation row id.
const _pending = new Map<string, Pending>()

let _sweeperHandle: ReturnType<typeof setInterval> | null = null
let _recoveryPromise: Promise<void> | null = null

/**
 * Register a pending escalation row, emit the SSE event, and return a
 * promise that resolves once the user decides (or the TTL elapses).
 */
export async function requestEscalation(input: EscalationRequestInput): Promise<EscalationDecision> {
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const expiresAt = new Date(Date.now() + ttlMs)

    const [row] = await db
        .insert(escalationRequests)
        .values({
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            agentId: input.agentId ?? null,
            toolName: input.toolName,
            payload: input.payload as Record<string, unknown>,
            reason: input.reason ?? null,
            expiresAt,
        })
        .returning()

    if (!row) {
        throw new Error('escalation row insert failed')
    }

    const id = row.id

    // Fire-and-forget audit log of the request itself.
    void logAuditEntry({
        workspaceId: input.workspaceId,
        extensionId: input.agentId ?? 'system',
        agentId: input.agentId,
        sessionId: input.sessionId,
        action: 'escalation_request',
        target: input.toolName,
        payload: input.payload,
        outcome: 'success',
        escalationOutcome: 'pending',
    })

    eventBus.emitSystem(TOPICS.ESCALATION_REQUESTED, {
        id,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        toolName: input.toolName,
        reason: input.reason,
        expiresAt: expiresAt.toISOString(),
        requestedAt: row.requestedAt?.toISOString() ?? new Date().toISOString(),
    })

    logger.info({ id, tool: input.toolName, ttlMs }, 'Escalation requested')

    return new Promise<EscalationDecision>((resolve) => {
        const timer = setTimeout(() => {
            // Local TTL fired before sweeper — resolve as timeout and
            // update the DB row if it's still pending.
            void handleTimeout(id, 'local-ttl')
        }, ttlMs)

        _pending.set(id, {
            resolve,
            timer,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            toolName: input.toolName,
        })
    })
}

async function handleTimeout(id: string, cause: string): Promise<void> {
    const pending = _pending.get(id)
    try {
        const [updated] = await db
            .update(escalationRequests)
            .set({ status: 'timeout', decidedAt: new Date() })
            .where(and(eq(escalationRequests.id, id), eq(escalationRequests.status, 'pending')))
            .returning()

        if (!updated) {
            // Already decided by someone else — drop the waiter and exit.
            if (pending) {
                clearTimeout(pending.timer)
                _pending.delete(id)
            }
            return
        }

        void logAuditEntry({
            workspaceId: updated.workspaceId,
            extensionId: updated.agentId ?? 'system',
            agentId: updated.agentId ?? undefined,
            sessionId: updated.sessionId,
            action: 'escalation_timeout',
            target: updated.toolName,
            payload: updated.payload,
            outcome: 'timeout',
            escalationOutcome: 'timeout',
        })

        const decision: EscalationDecision = {
            id,
            status: 'timeout',
            decidedAt: (updated.decidedAt ?? new Date()).toISOString(),
            reason: `escalation timed out (${cause})`,
        }

        eventBus.emitSystem(TOPICS.ESCALATION_DECIDED, {
            ...decision,
            workspaceId: updated.workspaceId,
            sessionId: updated.sessionId,
            toolName: updated.toolName,
        })

        if (pending) {
            clearTimeout(pending.timer)
            _pending.delete(id)
            pending.resolve(decision)
        }
    } catch (err) {
        logger.error({ err, id }, 'escalation timeout handling failed')
    }
}

/**
 * Mark an escalation row approved. Resolves the in-memory waiter (if the
 * request originated in this process) and emits ESCALATION_DECIDED.
 */
export async function approveEscalation(
    id: string,
    userId: string,
    note?: string,
): Promise<EscalationDecision | null> {
    const [updated] = await db
        .update(escalationRequests)
        .set({
            status: 'approved',
            decidedBy: userId,
            decidedAt: new Date(),
            decisionNote: note ?? null,
        })
        .where(and(eq(escalationRequests.id, id), eq(escalationRequests.status, 'pending')))
        .returning()

    if (!updated) return null

    void logAuditEntry({
        workspaceId: updated.workspaceId,
        extensionId: updated.agentId ?? 'system',
        agentId: updated.agentId ?? undefined,
        sessionId: updated.sessionId,
        action: 'escalation_approve',
        target: updated.toolName,
        payload: updated.payload,
        outcome: 'success',
        escalationOutcome: 'approved',
    })

    const decision: EscalationDecision = {
        id,
        status: 'approved',
        decidedBy: userId,
        decisionNote: note,
        decidedAt: (updated.decidedAt ?? new Date()).toISOString(),
    }

    eventBus.emitSystem(TOPICS.ESCALATION_DECIDED, {
        ...decision,
        workspaceId: updated.workspaceId,
        sessionId: updated.sessionId,
        toolName: updated.toolName,
    })

    const pending = _pending.get(id)
    if (pending) {
        clearTimeout(pending.timer)
        _pending.delete(id)
        pending.resolve(decision)
    }

    logger.info({ id, userId }, 'Escalation approved')
    return decision
}

/**
 * Mark an escalation row rejected. Resolves the waiter with a denial so
 * the agent can replan.
 */
export async function rejectEscalation(
    id: string,
    userId: string,
    note?: string,
): Promise<EscalationDecision | null> {
    const [updated] = await db
        .update(escalationRequests)
        .set({
            status: 'rejected',
            decidedBy: userId,
            decidedAt: new Date(),
            decisionNote: note ?? null,
        })
        .where(and(eq(escalationRequests.id, id), eq(escalationRequests.status, 'pending')))
        .returning()

    if (!updated) return null

    void logAuditEntry({
        workspaceId: updated.workspaceId,
        extensionId: updated.agentId ?? 'system',
        agentId: updated.agentId ?? undefined,
        sessionId: updated.sessionId,
        action: 'escalation_reject',
        target: updated.toolName,
        payload: updated.payload,
        outcome: 'denied',
        escalationOutcome: 'rejected',
    })

    const decision: EscalationDecision = {
        id,
        status: 'rejected',
        decidedBy: userId,
        decisionNote: note,
        decidedAt: (updated.decidedAt ?? new Date()).toISOString(),
        reason: note ?? 'rejected by user',
    }

    eventBus.emitSystem(TOPICS.ESCALATION_DECIDED, {
        ...decision,
        workspaceId: updated.workspaceId,
        sessionId: updated.sessionId,
        toolName: updated.toolName,
    })

    const pending = _pending.get(id)
    if (pending) {
        clearTimeout(pending.timer)
        _pending.delete(id)
        pending.resolve(decision)
    }

    logger.info({ id, userId }, 'Escalation rejected')
    return decision
}

/**
 * Start-of-process recovery: any pending row that already passed its TTL
 * by the time the process came up is aged out immediately.
 */
export async function recoverExpiredOnStartup(): Promise<number> {
    try {
        const now = new Date()
        const expired = await db
            .update(escalationRequests)
            .set({ status: 'timeout', decidedAt: now })
            .where(and(
                eq(escalationRequests.status, 'pending'),
                lt(escalationRequests.expiresAt, now),
            ))
            .returning({ id: escalationRequests.id })

        if (expired.length > 0) {
            logger.info({ count: expired.length }, 'Recovered expired escalations on startup')
        }
        return expired.length
    } catch (err) {
        logger.error({ err }, 'Escalation startup recovery failed')
        return 0
    }
}

/**
 * Sweeper tick — ages out pending rows past their deadline and resolves
 * any waiter still registered locally.
 */
export async function sweeperTick(): Promise<number> {
    let count = 0
    try {
        const now = new Date()
        const expired = await db
            .update(escalationRequests)
            .set({ status: 'timeout', decidedAt: now })
            .where(and(
                eq(escalationRequests.status, 'pending'),
                lt(escalationRequests.expiresAt, now),
            ))
            .returning()

        for (const row of expired) {
            count++
            void logAuditEntry({
                workspaceId: row.workspaceId,
                extensionId: row.agentId ?? 'system',
                agentId: row.agentId ?? undefined,
                sessionId: row.sessionId,
                action: 'escalation_timeout',
                target: row.toolName,
                payload: row.payload,
                outcome: 'timeout',
                escalationOutcome: 'timeout',
            })

            const decision: EscalationDecision = {
                id: row.id,
                status: 'timeout',
                decidedAt: (row.decidedAt ?? now).toISOString(),
                reason: 'escalation timed out (sweeper)',
            }

            eventBus.emitSystem(TOPICS.ESCALATION_DECIDED, {
                ...decision,
                workspaceId: row.workspaceId,
                sessionId: row.sessionId,
                toolName: row.toolName,
            })

            const pending = _pending.get(row.id)
            if (pending) {
                clearTimeout(pending.timer)
                _pending.delete(row.id)
                pending.resolve(decision)
            }
        }
    } catch (err) {
        logger.error({ err }, 'Escalation sweeper tick failed')
    }
    return count
}

/**
 * Start the background sweeper. Idempotent — a second call is a no-op.
 * Also kicks off startup recovery once.
 */
export function startEscalationSweeper(): void {
    if (_sweeperHandle) return
    if (!_recoveryPromise) {
        _recoveryPromise = recoverExpiredOnStartup().then(() => undefined)
    }
    _sweeperHandle = setInterval(() => {
        void sweeperTick()
    }, SWEEPER_INTERVAL_MS)
    // Don't block process exit on the sweeper
    if (typeof _sweeperHandle.unref === 'function') _sweeperHandle.unref()
}

/**
 * Test helper — stops the sweeper and drops all pending waiters.
 */
export function _stopEscalationSweeperForTests(): void {
    if (_sweeperHandle) {
        clearInterval(_sweeperHandle)
        _sweeperHandle = null
    }
    for (const [, p] of _pending) {
        clearTimeout(p.timer)
    }
    _pending.clear()
    _recoveryPromise = null
}

export function _getPendingCountForTests(): number {
    return _pending.size
}
