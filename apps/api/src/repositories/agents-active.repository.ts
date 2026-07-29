// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Active-agents-stream data-access repository (read-only).
 *
 * owns the two polled queries behind the workspace
 * active-agents SSE feed: in-flight tasks for a workspace and the latest
 * steps for those task ids. The route keeps the SSE wiring, snapshot
 * building, timers, and lifecycle. Workspace scoping + the active-status /
 * task-id filters are passed in and applied verbatim; both queries are
 * parameterised.
 */
import { eq, and, inArray, desc } from 'drizzle-orm'
import { db } from '@plexo/db'
import { taskSteps, tasks } from '@plexo/db'

/** In-flight (active-status) tasks for a workspace, oldest first, as snapshot rows. */
export async function listActiveTasks(workspaceId: string, activeStatuses: string[]) {
    return db
        .select({
            id: tasks.id,
            role: tasks.type,
            status: tasks.status,
            parentId: tasks.parentId,
            outcomeSummary: tasks.outcomeSummary,
        })
        .from(tasks)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, activeStatuses as any[])))
        .orderBy(tasks.createdAt)
}

/** Steps for the given task ids, ordered (taskId, stepNumber DESC) so first-per-task is latest. */
export async function listStepsForTasks(taskIds: string[]) {
    return db
        .select({
            taskId: taskSteps.taskId,
            stepNumber: taskSteps.stepNumber,
            stepType: taskSteps.stepType,
            state: taskSteps.state,
            outcome: taskSteps.outcome,
            error: taskSteps.error,
        })
        .from(taskSteps)
        .where(inArray(taskSteps.taskId, taskIds))
        .orderBy(taskSteps.taskId, desc(taskSteps.stepNumber))
}
