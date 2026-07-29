// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Queue application ports (ADR-0045 Phase 2).
 *
 * The queue use-case surface (`index.ts`) depends on this `TaskRepository`
 * abstraction, never on drizzle or the concrete `db` client. The drizzle
 * adapter (`drizzle-task-repository.ts`) is the only place that touches the ORM.
 *
 * Row passthrough: `claimNext`/`list` are hot read paths, so the drizzle row
 * type is passed through verbatim per the ADR-0045 Conflict-2 resolution
 * (map writes + complex reads; typed row passthrough allowed on simple reads).
 * The type is imported type-only from `@plexo/db`, so no ORM value crosses the
 * boundary.
 */

import type { tasks, TaskType, TaskStatus } from '@plexo/db'

/** Drizzle row for the `tasks` table — passed through on read paths. */
export type TaskRow = typeof tasks.$inferSelect

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
     * have already patched onto the row — see the adapter's `complete()`.
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

/** A fully-resolved row ready to insert (defaults already applied by the use-case). */
export interface NewTask {
    id: string
    workspaceId: string
    type: TaskType
    status: TaskStatus
    priority: number
    source: PushParams['source']
    project: string | null
    projectId: string | null
    parentId: string | null
    context: Record<string, unknown>
    costCeilingUsd: number | null
    tokenBudget: number | null
}

/** Persistence boundary for the task queue. */
export interface TaskRepository {
    /** Number of `queued` tasks for a workspace (SEC-043 cap check). */
    countQueued(workspaceId: string): Promise<number>
    /** Insert a fully-resolved task row. */
    insert(task: NewTask): Promise<void>
    /** Atomically claim the next queued task (FOR UPDATE SKIP LOCKED). */
    claimNext(timeoutSeconds: number): Promise<TaskRow | null>
    /** Mark a task complete; omits qualityScore when null (Phase M judge race). */
    complete(taskId: string, params: CompleteParams): Promise<void>
    /** Set terminal/blocked outcome (status + summary), releasing the claim. */
    setOutcome(taskId: string, status: TaskStatus, outcomeSummary: string): Promise<void>
    /** Cancel only if currently in a cancellable state; clears claim + retry timers. */
    cancel(taskId: string): Promise<void>
    /** List tasks by filter, ordered (priority ASC, createdAt ASC). */
    list(filter: ListFilter): Promise<TaskRow[]>
    /** Current attempt count, or null when the task does not exist. */
    getAttemptCount(taskId: string): Promise<number | null>
    /** Mark permanently failed after exhausting attempts. */
    failAfterAttempts(taskId: string, attempts: number): Promise<void>
    /** Requeue for a later retry, clearing claim state. */
    requeue(taskId: string, attemptCount: number, retryAfter: Date): Promise<void>
}
