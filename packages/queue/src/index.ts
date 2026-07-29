// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Task queue use-case surface (ADR-0045 Phase 2).
 *
 * Pure orchestration: queue-cap enforcement, retry backoff, and the
 * max-attempts decision live here. All persistence goes through the
 * `TaskRepository` port — this module imports neither drizzle nor the `db`
 * client. The default adapter is drizzle; `setTaskRepository` swaps it for an
 * in-memory fake in unit tests.
 */

import { ulid } from 'ulid'
import { DrizzleTaskRepository } from './drizzle-task-repository.js'
import type { TaskRepository, TaskRow, PushParams, CompleteParams, ListFilter } from './ports.js'

export type { TaskRepository, TaskRow, NewTask, PushParams, CompleteParams, ListFilter } from './ports.js'

const CLAIM_TIMEOUT_SECONDS = parseInt(process.env.CLAIM_TIMEOUT_SECONDS ?? '300', 10)

// ── Composition root + test seam ─────────────────────────────
let repo: TaskRepository = new DrizzleTaskRepository()

/** Swap the repository (e.g. an in-memory fake in unit tests). */
export function setTaskRepository(next: TaskRepository): void {
    repo = next
}

// ── Queue Operations ─────────────────────────────────────────

export async function push(params: PushParams): Promise<string> {
    // SEC-043: Per-workspace queue cap to prevent unbounded growth
    if ((await repo.countQueued(params.workspaceId)) >= 500) {
        throw new Error('Queue limit reached for this workspace')
    }

    const id = ulid()
    await repo.insert({
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
export async function claim(_agentId: string): Promise<TaskRow | null> {
    return repo.claimNext(CLAIM_TIMEOUT_SECONDS)
}

export async function complete(taskId: string, params: CompleteParams): Promise<void> {
    await repo.complete(taskId, params)
}

export async function block(taskId: string, reason: string): Promise<void> {
    await repo.setOutcome(taskId, 'blocked', reason)
}

/** FUN-013: Mark a task as permanently failed (unrecoverable — no credential, cost ceiling, max attempts). */
export async function fail(taskId: string, reason: string): Promise<void> {
    await repo.setOutcome(taskId, 'failed', reason)
}

export async function cancel(taskId: string): Promise<void> {
    await repo.cancel(taskId)
}

export async function list(filter: ListFilter = {}): Promise<TaskRow[]> {
    return repo.list(filter)
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

    const current = await repo.getAttemptCount(taskId)
    if (current === null) return 'max_attempts'
    const nextAttempt = current + 1

    if (nextAttempt > maxAttempts) {
        await repo.failAfterAttempts(taskId, nextAttempt)
        return 'max_attempts'
    }

    const backoffSec = backoffBase * Math.pow(2, nextAttempt - 1) // 120s, 240s, 480s
    await repo.requeue(taskId, nextAttempt, new Date(Date.now() + backoffSec * 1000))
    return 'requeued'
}

// ── Aliased exports for agent-loop compatibility ─────────────
export { claim as claimTask, complete as completeTask, block as blockTask, fail as failTask, push as pushTask }
