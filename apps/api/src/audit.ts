/**
 * Audit log helper
 *
 * Non-blocking fire-and-forget write to audit_log table.
 * Never throws — audit failure must never break the calling request.
 *
 * Usage:
 *   audit(req, { workspaceId, action: 'member.add', resource: 'workspace_members',
 *                resourceId: userId, metadata: { role, email } })
 */
import { db } from '@plexo/db'
import { auditLog } from '@plexo/db'
import type { Request } from 'express'
import pino from 'pino'

const logger = pino({ name: 'audit' })

export interface AuditEntry {
    workspaceId: string
    userId?: string
    action: string
    resource: string
    resourceId?: string
    metadata?: Record<string, unknown>
}

export function audit(req: Request | null, entry: AuditEntry): void {
    const ip = req
        ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress
        : undefined

    db.insert(auditLog).values({
        workspaceId: entry.workspaceId,
        userId: entry.userId ?? null,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? {},
        ip: ip ?? null,
    }).catch((err: unknown) => {
        // Non-fatal — audit failure must not break calling request
        logger.error({ err, action: entry.action }, 'Audit write failed')
    })
}
