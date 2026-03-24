// SPDX-License-Identifier: AGPL-3.0-only
import { db, eq, and } from '@plexo/db'
import { installedConnections, workspaceMembers } from '@plexo/db'
import { decrypt } from '../../crypto.js'
import type { Request } from 'express'

export interface ResolvedCredentials {
    [key: string]: unknown
}

/**
 * Resolve the workspace ID for cmd-center operations.
 * Uses CMD_CENTER_WORKSPACE_ID env var, or falls back to the user's first workspace.
 */
export async function resolveWorkspaceId(req: Request): Promise<string | null> {
    if (process.env.CMD_CENTER_WORKSPACE_ID) {
        return process.env.CMD_CENTER_WORKSPACE_ID
    }
    if (req.user?.id) {
        const [row] = await db.select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, req.user.id))
            .limit(1)
        return row?.workspaceId ?? null
    }
    return null
}

/**
 * Resolve and decrypt connection credentials for a given registry ID.
 */
export async function resolveCredentials(workspaceId: string, registryId: string): Promise<ResolvedCredentials | null> {
    const [row] = await db.select({
        credentials: installedConnections.credentials,
    }).from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, registryId),
            eq(installedConnections.status, 'active'),
        ))
        .limit(1)

    if (!row) return null

    const raw = row.credentials as { encrypted?: string } | null
    if (!raw?.encrypted) return null

    try {
        const decrypted = decrypt(raw.encrypted, workspaceId)
        return JSON.parse(decrypted) as ResolvedCredentials
    } catch {
        return null
    }
}
