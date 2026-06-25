// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tool-dispatch data-access repository.
 *
 * owns the installed-extension lookup behind POST
 * /tools/invoke. The route keeps auth, validation, and dispatch shaping.
 * Workspace scoping is enforced inside the query.
 */
import { db, eq, and } from '@plexo/db'
import { extensions } from '@plexo/db'

/** The installed extension matching a tool name within a workspace, if any. */
export async function findInstalledByName(workspaceId: string, toolName: string) {
    const installed = await db.select({
        id: extensions.id,
        name: extensions.name,
        enabled: extensions.enabled,
        manifest: extensions.manifest,
    })
    .from(extensions)
    .where(and(
        eq(extensions.workspaceId, workspaceId),
        eq(extensions.name, toolName),
    ))
    .limit(1)
    return installed[0]
}
