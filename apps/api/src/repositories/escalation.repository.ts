// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Escalation-inbox data-access repository (read-only list).
 *
 * owns the escalation-queue list query for the Escalation
 * API. The route keeps workspace-membership auth, the SSE stream, and the
 * approve/reject orchestration (those decision side-effects live in
 * @plexo/agent/escalation/manager). Workspace + status scoping is preserved
 * verbatim and parameterised.
 */
import { and, eq, desc } from 'drizzle-orm'
import { db } from '@plexo/db'
import { escalationRequests } from '@plexo/db'

/** Escalation rows for a workspace filtered by status, newest-requested first, capped. */
export async function listEscalations(workspaceId: string, status: string) {
    return db
        .select()
        .from(escalationRequests)
        .where(and(
            eq(escalationRequests.workspaceId, workspaceId),
            eq(escalationRequests.status, status),
        ))
        .orderBy(desc(escalationRequests.requestedAt))
        .limit(200)
}
