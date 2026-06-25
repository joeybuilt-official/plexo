// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * OAuth connection persistence (installed_connections).
 *
 * owns the installed_connections reads/writes the OAuth
 * callback performs. Credential encryption + scope parsing stay in the route.
 */
import { eq, and } from 'drizzle-orm'
import { db } from '@plexo/db'
import { installedConnections } from '@plexo/db'

type NewInstalledConnection = typeof installedConnections.$inferInsert

/** Find an existing connection id for (workspace, registry, label), or undefined. */
export async function findConnectionId(workspaceId: string, registryId: string, label: string): Promise<string | undefined> {
    const [existing] = await db
        .select({ id: installedConnections.id })
        .from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, registryId),
            eq(installedConnections.label, label),
        ))
        .limit(1)
    return existing?.id
}

/** Update an existing connection's credentials + status. */
export async function updateConnection(id: string, fields: Partial<NewInstalledConnection>): Promise<void> {
    await db.update(installedConnections).set(fields).where(eq(installedConnections.id, id))
}

/** Insert a new connection. */
export async function insertConnection(values: NewInstalledConnection): Promise<void> {
    await db.insert(installedConnections).values(values)
}
