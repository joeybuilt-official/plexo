// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, and, sql, asc, inArray, tasks, type TaskType, type TaskStatus } from '@plexo/db'
import { ulid } from 'ulid'

const CLAIM_TIMEOUT_SECONDS = parseInt(process.env.CLAIM_TIMEOUT_SECONDS ?? '300', 10)

// ── Types ────────────────────────────────────────────────────

export interface PushParams {
    workspaceId: string
    type: TaskType
    source: 'telegram' | 'slack' | 'discord' | 'scanner' | 'github' | 'cron' | 'dashboard' | 'api' | 'extension' | 'sentry' | 'a2a' | 'webhook' | 'twilio' | 'gmail' | 'gmessages'
    context: Record<string, unknown>
    priority?: number
    project?: string
    projectId?: string   // FK → sprints.id — the project this task belongs to
    parentId?: string
    status?: TaskStatus
    /** Max USD this task may spend. null = inherit workspace default. */
    costCeilingUsd?: number
    /** Max output tokens. 0 = no cap. */
    tokenBudget?: number
}

export interface CompleteParams {
    /**
     * null = quality pending (the judge settles off the completion hot path,
     * Phase M). A null here MUST NOT overwrite a score the detached judge may
     * have already patched onto the row — see `complete()`.
     */
    qualityScore: number | null
    outcomeSummary: string
    tokensIn: number
    tokensOut: number
    costUsd: number
}

export interface ListFilter {
    workspaceId?: string
    status?: string | string[]
    type?: string
    source?: string
    project?: string
    projectId?: string   // filter by sprint/project FK
    parentId?: string    // filter by parent task (sub-agent children)
    limit?: number
    cursor?: string
}

// ── Queue Operations ─────────────────────────────────────────

export async function push(params: PushParams): Promise<string> {
    // SEC-043: Per-workspace queue cap to prevent unbounded growth
    const rows = await db.select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, params.workspaceId), eq(tasks.status, 'queued' as TaskStatus)))
    if ((rows[0]?.count ?? 0) >= 500) throw new Error('Queue limit reached for this workspace')

    const id = ulid()
    await db.insert(tasks).values({
        id,
        workspaceId: params.workspaceId,
        type: params.type,
        status: params.status ?? 'queued',
        priority: params.priority ?? 1,
        source: params.source,
        project: params.project ?? null,
        projectId: params.projectId ?? null,
        parentId: params.parentId ?? null,
        context: params.context,
        costCeilingUsd: params.costCeilingUsd ?? null,
        tokenBudget: params.tokenBudget ?? null,
    })
    return id
}

/**
 * Atomic single-task claim: SELECT FOR UPDATE SKIP LOCKED prevents double-claim.
 *
 * agentId is reserved for an upcoming claimed_by column. For now it's
 * unused at the SQL layer but kept in the signature so call sites can
 * already pass their agent identity. Using underscore prefix to silence
 * the unused-arg lint without changing the public API.
 */
export async function claim(_agentId: string): Promise<typeof tasks.$inferSelect | null> {
    const result = await db.execute<typeof tasks.$inferSelect>(sql`
    UPDATE tasks
    SET status = 'claimed',
        claimed_at = NOW(),
        claimed_until = NOW() + (${CLAIM_TIMEOUT_SECONDS} || ' seconds')::interval
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= NOW())
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `)

    return result[0] ?? null
}

export async function complete(taskId: string, params: CompleteParams): Promise<void> {
    const set: Partial<typeof tasks.$inferInsert> = {
        status: 'complete',
        outcomeSummary: params.outcomeSummary,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        costUsd: params.costUsd,
        completedAt: new Date(),
        claimedUntil: null,
    }
    // Phase M: the quality judge runs off the hot path and patches the score
    // asynchronously. A null score here means "pending" — skip the column so we
    // never clobber a value the detached judge may have already written (the
    // two writes race; the judge's real score must win regardless of order).
    if (params.qualityScore != null) set.qualityScore = params.qualityScore
    await db.update(tasks).set(set).where(eq(tasks.id, taskId))
}

export async function block(taskId: string, reason: string): Promise<void> {
    await db.update(tasks)
        .set({ status: 'blocked', outcomeSummary: reason, claimedUntil: null })
        .where(eq(tasks.id, taskId))
}

/** FUN-013: Mark a task as permanently failed (unrecoverable — no credential, cost ceiling, max attempts). */
export async function fail(taskId: string, reason: string): Promise<void> {
    await db.update(tasks)
        .set({ status: 'failed', outcomeSummary: reason, claimedUntil: null })
        .where(eq(tasks.id, taskId))
}

export async function cancel(taskId: string): Promise<void> {
    // Only cancel tasks in cancellable states — don't overwrite complete/failed/cancelled.
    // Clear claimed_at, claimed_until, and retry_after so the task doesn't keep
    // holding a parallel slot, the claim-timeout sweeper, or a pending retry timer.
    await db.update(tasks)
        .set({ status: 'cancelled', claimedAt: null, claimedUntil: null, retryAfter: null })
        .where(and(eq(tasks.id, taskId), inArray(tasks.status, ['queued', 'claimed', 'running', 'blocked', 'awaiting_approval'] as TaskStatus[])))
}

export async function list(filter: ListFilter = {}): Promise<(typeof tasks.$inferSelect)[]> {
    const conditions = []

    if (filter.workspaceId) {
        conditions.push(eq(tasks.workspaceId, filter.workspaceId))
    }
    if (filter.status) {
        if (Array.isArray(filter.status)) {
            conditions.push(inArray(tasks.status, filter.status as TaskStatus[]))
        } else {
            conditions.push(eq(tasks.status, filter.status as TaskStatus))
        }
    }
    if (filter.type) {
        conditions.push(eq(tasks.type, filter.type as TaskType))
    }
    if (filter.project) {
        conditions.push(eq(tasks.project, filter.project))
    }
    if (filter.projectId) {
        conditions.push(eq(tasks.projectId, filter.projectId))
    }
    if (filter.parentId) {
        conditions.push(eq(tasks.parentId, filter.parentId))
    }
    // Queue-bug-fix: cursor pagination must align with the order key.
    // Order is (priority ASC, createdAt ASC), so the cursor is the createdAt
    // of the last row from the previous page. Encoded as ISO timestamp.
    if (filter.cursor) {
        const cursorDate = new Date(filter.cursor)
        if (!Number.isNaN(cursorDate.getTime())) {
            conditions.push(sql`${tasks.createdAt} > ${cursorDate}`)
        }
    }

    const query = db.select().from(tasks)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(tasks.priority), asc(tasks.createdAt))
        .limit(filter.limit ?? 50)

    return query
}
// ── Centralized retry with exponential backoff (FUN-037) ────

/**
 * Requeue a task for retry with exponential backoff.
 * Increments attemptCount and sets retryAfter. If max attempts exceeded,
 * marks the task as failed.
 *
 * Replaces inline retry logic previously scattered in agent-loop and
 * ghost-task recovery. Callers should use this instead of manually
 * manipulating attemptCount/retryAfter/status.
 */
export async function requeueForRetry(
    taskId: string,
    opts?: { maxAttempts?: number; backoffBase?: number },
): Promise<'requeued' | 'max_attempts'> {
    const maxAttempts = opts?.maxAttempts ?? 3
    const backoffBase = opts?.backoffBase ?? 120 // seconds

    const [task] = await db.select({ attemptCount: tasks.attemptCount })
        .from(tasks).where(eq(tasks.id, taskId)).limit(1)

    if (!task) return 'max_attempts'
    const nextAttempt = (task.attemptCount ?? 0) + 1

    if (nextAttempt > maxAttempts) {
        await db.update(tasks)
            .set({
                status: 'failed' as TaskStatus,
                outcomeSummary: `Failed after ${nextAttempt} attempts`,
                claimedAt: null,
                claimedUntil: null,
            })
            .where(eq(tasks.id, taskId))
        return 'max_attempts'
    }

    const backoffSec = backoffBase * Math.pow(2, nextAttempt - 1) // 120s, 240s, 480s
    // Queue-bug-fix: clear claimed_at and claimed_until so the task is no
    // longer treated as active. Without this, ghost recovery, parallel-slot
    // eviction, and the claim-timeout sweeper can all still see stale claim
    // state and refuse to release the slot.
    await db.update(tasks).set({
        status: 'queued' as TaskStatus,
        attemptCount: nextAttempt,
        retryAfter: new Date(Date.now() + backoffSec * 1000),
        claimedAt: null,
        claimedUntil: null,
    }).where(eq(tasks.id, taskId))

    return 'requeued'
}

// ── Aliased exports for agent-loop compatibility ─────────────
export { claim as claimTask, complete as completeTask, block as blockTask, fail as failTask, push as pushTask }
