// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sprint-engine data-access repository.
 *
 * owns the sprints / sprint_tasks / sprint_logs reads and
 * writes behind the sprint-runner routes, plus the sprint-scoped task
 * cancellation queries. The route keeps AI-credential pre-flight, the
 * fire-and-forget runner orchestration, SSE emits, analytics, and the
 * in-process executor abort (cancelActiveTask).
 */
import { eq, and, asc, desc, inArray } from 'drizzle-orm'
import { db } from '@plexo/db'
import { sprints, sprintTasks, sprintLogs, tasks } from '@plexo/db'

/** Full sprint row by id, or undefined. */
export async function getSprint(sprintId: string) {
    const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1)
    return sprint
}

/** List sprints matching the given conditions, newest-first, capped. */
export async function listSprints(conditions: ReturnType<typeof eq>[], limit: number) {
    return db.select().from(sprints)
        .where(and(...conditions))
        .orderBy(desc(sprints.createdAt))
        .limit(limit)
}

/** Insert a sprint, returning the full inserted row. (Listing-route variant.) */
export async function insertSprint(values: typeof sprints.$inferInsert) {
    const [sprint] = await db.insert(sprints).values(values).returning()
    return sprint
}

/** Key task columns linked to a sprint via tasks.project, newest-first (cap 200). */
export async function listTasksForSprintProject(sprintId: string) {
    return db.select({
        id: tasks.id,
        type: tasks.type,
        status: tasks.status,
        source: tasks.source,
        outcomeSummary: tasks.outcomeSummary,
        qualityScore: tasks.qualityScore,
        costUsd: tasks.costUsd,
        createdAt: tasks.createdAt,
        completedAt: tasks.completedAt,
    }).from(tasks)
        .where(eq(tasks.project, sprintId))
        .orderBy(desc(tasks.createdAt))
        .limit(200)
}

/** Lightweight {workspaceId} snapshot for a sprint, or undefined. */
export async function getSprintWorkspaceId(sprintId: string) {
    const [existing] = await db.select({ workspaceId: sprints.workspaceId }).from(sprints).where(eq(sprints.id, sprintId)).limit(1)
    return existing
}

/** Apply a partial update to a sprint by id, returning the full updated row. */
export async function updateSprintReturning(sprintId: string, set: Partial<typeof sprints.$inferInsert>) {
    const [updated] = await db.update(sprints).set(set).where(eq(sprints.id, sprintId)).returning()
    return updated
}

/** Insert a sprint, returning the full inserted row. */
export async function createSprint(values: typeof sprints.$inferInsert) {
    const [sprint] = await db.insert(sprints).values(values).returning()
    return sprint
}

/** Lightweight {id,status,workspaceId} snapshot for the cancel flow. */
export async function getSprintCancelMeta(sprintId: string) {
    const [sprint] = await db
        .select({ id: sprints.id, status: sprints.status, workspaceId: sprints.workspaceId })
        .from(sprints)
        .where(eq(sprints.id, sprintId))
        .limit(1)
    return sprint
}

/** The repo slug for a sprint, or undefined. */
export async function getSprintRepo(sprintId: string) {
    const [sprint] = await db.select({ repo: sprints.repo }).from(sprints)
        .where(eq(sprints.id, sprintId)).limit(1)
    return sprint
}

/** Apply a partial update to a sprint by id. */
export async function updateSprint(sprintId: string, set: Partial<typeof sprints.$inferInsert>): Promise<void> {
    await db.update(sprints).set(set).where(eq(sprints.id, sprintId))
}

/** Hard-delete a sprint (cascades sprint_tasks/sprint_logs; tasks.project_id set null). */
export async function deleteSprint(sprintId: string): Promise<void> {
    await db.delete(sprints).where(eq(sprints.id, sprintId))
}

/** All task ids belonging to a sprint (tasks.project_id = sprintId). */
export async function getTaskIdsForSprint(sprintId: string): Promise<string[]> {
    const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, sprintId))
    return rows.map((r) => r.id)
}

/** Mark cancellable tasks (queued/claimed/running/blocked) as cancelled. */
export async function cancelCancellableTasks(taskIds: string[]): Promise<void> {
    await db.update(tasks)
        .set({ status: 'cancelled' })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(and(inArray(tasks.id, taskIds), inArray(tasks.status, ['queued', 'claimed', 'running', 'blocked'] as any[])))
}

/** Sprint-task {id,status} rows for a sprint. */
export async function listSprintTaskStatuses(sprintId: string) {
    return db
        .select({ id: sprintTasks.id, status: sprintTasks.status })
        .from(sprintTasks)
        .where(eq(sprintTasks.sprintId, sprintId))
}

/** Mark the given sprint_tasks rows as failed. */
export async function failSprintTasks(ids: string[]): Promise<void> {
    await db.update(sprintTasks).set({ status: 'failed' }).where(inArray(sprintTasks.id, ids))
}

/** Full sprint-task rows for a sprint, by priority (capped 500). */
export async function listSprintTasks(sprintId: string) {
    return db.select().from(sprintTasks)
        .where(eq(sprintTasks.sprintId, sprintId))
        .orderBy(sprintTasks.priority)
        .limit(500)
}

/** Activity-log rows for a sprint, oldest-first. */
export async function listSprintLogs(sprintId: string, limit: number) {
    return db.select().from(sprintLogs)
        .where(eq(sprintLogs.sprintId, sprintId))
        .orderBy(asc(sprintLogs.createdAt))
        .limit(limit)
}
