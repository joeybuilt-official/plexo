// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Audit-log data-access repository (read-only).
 *
 * owns the audit-log list query for the Audit API. The
 * route keeps validation, action-prefix/cursor parsing, and response shaping.
 * Workspace scoping is preserved verbatim; the optional action-prefix and
 * before-cursor predicates are passed in and applied inside the query.
 */
import { eq, and, desc, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { auditLog, users } from '@plexo/db'

/** Audit-log rows for a workspace (with user join), action-prefix + before-cursor filtered, newest first, capped. */
export async function listAuditEntries(
    workspaceId: string,
    opts: { actionPrefix?: string; before?: Date; limit: number },
) {
    const conditions = [eq(auditLog.workspaceId, workspaceId)]
    if (opts.actionPrefix) {
        conditions.push(sql`${auditLog.action} LIKE ${opts.actionPrefix + '%'}`)
    }
    if (opts.before) {
        conditions.push(sql`${auditLog.createdAt} < ${opts.before}`)
    }
    return db
        .select({
            id: auditLog.id,
            action: auditLog.action,
            resource: auditLog.resource,
            resourceId: auditLog.resourceId,
            metadata: auditLog.metadata,
            ip: auditLog.ip,
            createdAt: auditLog.createdAt,
            userId: auditLog.userId,
            userName: users.name,
            userEmail: users.email,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(opts.limit)
}
