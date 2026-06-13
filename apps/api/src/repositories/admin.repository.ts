// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cross-workspace admin (Command Center) data-access repository.
 *
 * arch-findings B1 — owns the super-admin read queries plus the attachment
 * rescan and workspace provisioning writes. The route keeps the super-admin
 * auth gate, env-derived isSuperAdmin computation, Map building, audit emit,
 * and response shaping. These endpoints are intentionally cross-workspace
 * (super-admin only) — there is no per-workspace authz to preserve.
 */
import { db, eq, desc, sql, count } from '@plexo/db'
import { workspaces, tasks, users, installedConnections, memoryEntries, auditLog, workspaceMembers, attachmentScanQueue } from '@plexo/db'

type TaskStatus = 'queued' | 'claimed' | 'running' | 'complete' | 'blocked' | 'cancelled' | 'awaiting_approval'

/** Newest 100 workspaces (id/name/owner/createdAt). */
export async function listWorkspaces() {
    return db
        .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, createdAt: workspaces.createdAt })
        .from(workspaces)
        .orderBy(desc(workspaces.createdAt))
        .limit(100)
}

/** Task counts grouped by workspace. */
export async function getTaskCountsByWorkspace() {
    return db.select({ workspaceId: tasks.workspaceId, total: count() }).from(tasks).groupBy(tasks.workspaceId)
}

/** Member counts grouped by workspace. */
export async function getMemberCountsByWorkspace() {
    return db.select({ workspaceId: workspaceMembers.workspaceId, total: count() }).from(workspaceMembers).groupBy(workspaceMembers.workspaceId)
}

/** A workspace's basic fields by id. */
export async function getWorkspaceBasic(id: string) {
    const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, createdAt: workspaces.createdAt })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
    return ws
}

/** Newest 10 tasks for a workspace (detail view). */
export async function listRecentTasks(workspaceId: string) {
    return db
        .select({ id: tasks.id, title: tasks.outcomeSummary, status: tasks.status, type: tasks.type, createdAt: tasks.createdAt })
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
        .orderBy(desc(tasks.createdAt))
        .limit(10)
}

/** Installed connections for a workspace. */
export async function listWorkspaceConnections(workspaceId: string) {
    return db
        .select({ id: installedConnections.id, type: installedConnections.registryId, name: installedConnections.name, status: installedConnections.status })
        .from(installedConnections)
        .where(eq(installedConnections.workspaceId, workspaceId))
}

/** Members of a workspace. */
export async function listWorkspaceMembers(workspaceId: string) {
    return db
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))
}

/** Newest 100 platform users. */
export async function listUsers() {
    return db
        .select({ id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(100)
}

const TASK_LIST_COLUMNS = {
    id: tasks.id,
    title: tasks.outcomeSummary,
    status: tasks.status,
    type: tasks.type,
    workspaceId: tasks.workspaceId,
    createdAt: tasks.createdAt,
    completedAt: tasks.completedAt,
}

/** Newest tasks across all workspaces, capped at limit. */
export async function listAllTasks(limit: number) {
    return db.select(TASK_LIST_COLUMNS).from(tasks).orderBy(desc(tasks.createdAt)).limit(limit)
}

/** Newest tasks filtered by status, capped at limit. */
export async function listTasksByStatus(status: TaskStatus, limit: number) {
    return db.select(TASK_LIST_COLUMNS).from(tasks).where(eq(tasks.status, status)).orderBy(desc(tasks.createdAt)).limit(limit)
}

/** Task counts grouped by status. */
export async function getTaskStatusCounts() {
    return db.select({ status: tasks.status, total: count() }).from(tasks).groupBy(tasks.status)
}

/** Count of tasks created in the trailing 7 days. */
export async function getTasksLastWeek(): Promise<Array<{ total: number }>> {
    return db.select({ total: count() }).from(tasks).where(sql`${tasks.createdAt} >= NOW() - INTERVAL '7 days'`)
}

/** Liveness ping. */
export async function pingDb() {
    return db.execute(sql`SELECT 1 AS ok`)
}

export async function countWorkspaces() { return db.select({ total: count() }).from(workspaces) }
export async function countUsers() { return db.select({ total: count() }).from(users) }
export async function countTasks() { return db.select({ total: count() }).from(tasks) }
export async function countMemoryEntries() { return db.select({ total: count() }).from(memoryEntries) }

/** Newest 200 installed connections across all workspaces. */
export async function listAllConnections() {
    return db
        .select({ id: installedConnections.id, type: installedConnections.registryId, name: installedConnections.name, status: installedConnections.status, workspaceId: installedConnections.workspaceId, createdAt: installedConnections.createdAt })
        .from(installedConnections)
        .orderBy(desc(installedConnections.createdAt))
        .limit(200)
}

/** Cross-workspace audit log entries, capped at limit. */
export async function listAuditLog(limit: number) {
    return db
        .select({ id: auditLog.id, userId: auditLog.userId, action: auditLog.action, resource: auditLog.resource, resourceId: auditLog.resourceId, metadata: auditLog.metadata, createdAt: auditLog.createdAt })
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
}

/** Re-enqueue an attachment scan by content hash; returns affected {id,workspaceId} rows. */
export async function rescanAttachment(contentHash: string): Promise<Array<{ id: string; workspaceId: string }>> {
    return db
        .update(attachmentScanQueue)
        .set({ completedAt: null, startedAt: null, consecutiveFailures: 0, lastError: null, result: null, nextAttemptAt: new Date() })
        .where(eq(attachmentScanQueue.contentHash, contentHash))
        .returning({ id: attachmentScanQueue.id, workspaceId: attachmentScanQueue.workspaceId })
}

/** Resolve a user id by email. */
export async function findUserByEmail(email: string): Promise<{ id: string } | undefined> {
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    return owner
}

/** Provision a new workspace, returning basic fields. */
export async function insertWorkspace(values: typeof workspaces.$inferInsert) {
    const [ws] = await db.insert(workspaces).values(values).returning({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        createdAt: workspaces.createdAt,
    })
    return ws
}
