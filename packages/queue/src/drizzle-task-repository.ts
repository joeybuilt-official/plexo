// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the task queue (ADR-0045 Phase 2).
 *
 * The ONLY queue module permitted to import the ORM. Operators come from
 * `drizzle-orm` directly (not the `@plexo/db` barrel) so this stays correct
 * once the barrel stops re-exporting them. SQL is unchanged from the previous
 * in-line implementation in `index.ts`.
 */

import { db, tasks } from '@plexo/db'
import type { TaskStatus } from '@plexo/db'
import { eq, and, sql, asc, inArray } from 'drizzle-orm'
import type {
    TaskRepository,
    NewTask,
    CompleteParams,
    ListFilter,
    TaskRow,
} from './ports.js'

export class DrizzleTaskRepository implements TaskRepository {
    async countQueued(workspaceId: string): Promise<number> {
        const rows = await db.select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'queued' as TaskStatus)))
        return rows[0]?.count ?? 0
    }

    async insert(task: NewTask): Promise<void> {
        await db.insert(tasks).values(task)
    }

    async claimNext(timeoutSeconds: number): Promise<TaskRow | null> {
        const result = await db.execute<TaskRow>(sql`
    UPDATE tasks
    SET status = 'claimed',
        claimed_at = NOW(),
        claimed_until = NOW() + (${timeoutSeconds} || ' seconds')::interval
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

    async complete(taskId: string, params: CompleteParams): Promise<void> {
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

    async setOutcome(taskId: string, status: TaskStatus, outcomeSummary: string): Promise<void> {
        await db.update(tasks)
            .set({ status, outcomeSummary, claimedUntil: null })
            .where(eq(tasks.id, taskId))
    }

    async cancel(taskId: string): Promise<void> {
        // Only cancel tasks in cancellable states — don't overwrite complete/failed/cancelled.
        // Clear claimed_at, claimed_until, and retry_after so the task doesn't keep
        // holding a parallel slot, the claim-timeout sweeper, or a pending retry timer.
        await db.update(tasks)
            .set({ status: 'cancelled', claimedAt: null, claimedUntil: null, retryAfter: null })
            .where(and(eq(tasks.id, taskId), inArray(tasks.status, ['queued', 'claimed', 'running', 'blocked', 'awaiting_approval'] as TaskStatus[])))
    }

    async list(filter: ListFilter): Promise<TaskRow[]> {
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
            conditions.push(eq(tasks.type, filter.type as TaskRow['type']))
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

        return db.select().from(tasks)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(asc(tasks.priority), asc(tasks.createdAt))
            .limit(filter.limit ?? 50)
    }

    async getAttemptCount(taskId: string): Promise<number | null> {
        const [task] = await db.select({ attemptCount: tasks.attemptCount })
            .from(tasks).where(eq(tasks.id, taskId)).limit(1)
        if (!task) return null
        return task.attemptCount ?? 0
    }

    async failAfterAttempts(taskId: string, attempts: number): Promise<void> {
        await db.update(tasks)
            .set({
                status: 'failed' as TaskStatus,
                outcomeSummary: `Failed after ${attempts} attempts`,
                claimedAt: null,
                claimedUntil: null,
            })
            .where(eq(tasks.id, taskId))
    }

    async requeue(taskId: string, attemptCount: number, retryAfter: Date): Promise<void> {
        // Queue-bug-fix: clear claimed_at and claimed_until so the task is no
        // longer treated as active. Without this, ghost recovery, parallel-slot
        // eviction, and the claim-timeout sweeper can all still see stale claim
        // state and refuse to release the slot.
        await db.update(tasks).set({
            status: 'queued' as TaskStatus,
            attemptCount,
            retryAfter,
            claimedAt: null,
            claimedUntil: null,
        }).where(eq(tasks.id, taskId))
    }
}
