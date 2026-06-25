// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension audit-log data-access repository (read-only).
 *
 * owns extension_audit_log reads. The filter-condition builder
 * moved in here from the route (it's data-shaping); the route passes a typed
 * filter parsed from query params.
 */
import { eq, and, desc, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { extensionAuditLog } from '@plexo/db'

type AuditRow = typeof extensionAuditLog.$inferSelect

export interface AuditFilters {
    workspaceId: string
    extensionId?: string
    agentId?: string
    tool?: string
    action?: string
    outcome?: string
    from?: string
    to?: string
}

function buildConditions(f: AuditFilters): unknown[] {
    const conditions: unknown[] = [eq(extensionAuditLog.workspaceId, f.workspaceId)]
    if (f.extensionId) conditions.push(eq(extensionAuditLog.extensionId, f.extensionId))
    if (f.agentId) conditions.push(eq(extensionAuditLog.agentId, f.agentId))
    if (f.tool) conditions.push(eq(extensionAuditLog.target, f.tool))
    if (f.action) conditions.push(eq(extensionAuditLog.action, f.action))
    if (f.outcome) conditions.push(eq(extensionAuditLog.outcome, f.outcome))
    if (f.from) conditions.push(sql`${extensionAuditLog.createdAt} >= ${new Date(f.from)}`)
    if (f.to) conditions.push(sql`${extensionAuditLog.createdAt} <= ${new Date(f.to)}`)
    return conditions
}

/** Paginated audit rows for the filters, newest first. */
export async function listAuditLog(filters: AuditFilters, limit: number, offset: number): Promise<AuditRow[]> {
    const conditions = buildConditions(filters)
    return db
        .select()
        .from(extensionAuditLog)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(desc(extensionAuditLog.createdAt))
        .limit(limit)
        .offset(offset)
}

/** Total audit rows matching the filters. */
export async function countAuditLog(filters: AuditFilters): Promise<number> {
    const conditions = buildConditions(filters)
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(extensionAuditLog)
        .where(and(...(conditions as Parameters<typeof and>)))
    return row?.count ?? 0
}

/** Last `cap` rows matching the filters (for in-memory grouping). */
export async function listForGrouping(filters: AuditFilters, cap: number): Promise<AuditRow[]> {
    const conditions = buildConditions(filters)
    return db
        .select()
        .from(extensionAuditLog)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(desc(extensionAuditLog.createdAt))
        .limit(cap)
}
