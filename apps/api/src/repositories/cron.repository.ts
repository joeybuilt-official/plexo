// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cron-jobs data-access repository.
 *
 * owns the cron_jobs reads/writes. The route keeps NL→cron
 * parsing, schedule/scheduleAt validation, reminder channel resolution, the
 * task-type allow-list, queue push, and analytics. Channel lookups live in
 * channels.repository. All queries are workspace-scoped (object-level authz).
 */
import { eq, and, desc, isNull, isNotNull } from 'drizzle-orm'
import { db } from '@plexo/db'
import { cronJobs } from '@plexo/db'

/** List cron jobs for a workspace, filtered by kind (reminder=no schedule, schedule=has schedule). */
export async function listCronJobs(workspaceId: string, kind: 'reminder' | 'schedule' | 'all') {
    const wsFilter = eq(cronJobs.workspaceId, workspaceId)
    const where = kind === 'reminder'
        ? and(wsFilter, isNull(cronJobs.schedule))
        : kind === 'schedule'
            ? and(wsFilter, isNotNull(cronJobs.schedule))
            : wsFilter
    return db.select().from(cronJobs).where(where).orderBy(desc(cronJobs.createdAt))
}

/** Insert a cron job, returning the created row. */
export async function createCronJob(values: typeof cronJobs.$inferInsert) {
    const [created] = await db.insert(cronJobs).values(values).returning()
    return created
}

/** {taskType} of a workspace-scoped cron job, or undefined. */
export async function getTaskType(id: string, workspaceId: string): Promise<{ taskType: string | null } | undefined> {
    const [existing] = await db
        .select({ taskType: cronJobs.taskType })
        .from(cronJobs)
        .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
        .limit(1)
    return existing as { taskType: string | null } | undefined
}

/** Apply a partial update to a workspace-scoped cron job. */
export async function updateCronJob(id: string, workspaceId: string, set: Record<string, unknown>): Promise<void> {
    await db.update(cronJobs).set(set).where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
}

/** Delete a workspace-scoped cron job. */
export async function deleteCronJob(id: string, workspaceId: string): Promise<void> {
    await db.delete(cronJobs).where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
}

/** Full workspace-scoped cron job row, or undefined. */
export async function getCronJob(id: string, workspaceId: string) {
    const [job] = await db.select().from(cronJobs)
        .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
        .limit(1)
    return job
}

/** Stamp lastRunAt=now on a cron job. */
export async function touchLastRun(id: string): Promise<void> {
    await db.update(cronJobs).set({ lastRunAt: new Date() }).where(eq(cronJobs.id, id))
}
