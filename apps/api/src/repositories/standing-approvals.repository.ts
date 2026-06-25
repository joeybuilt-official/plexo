// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Standing approvals data-access repository (§23).
 *
 * owns standing_approvals persistence, shared by the
 * standing-approvals routes and the approve-and-remember path in approvals.ts.
 * Delete is workspace-scoped (object-level authz preserved).
 */
import { db, eq, and } from '@plexo/db'
import { standingApprovals } from '@plexo/db'

type StandingApproval = typeof standingApprovals.$inferSelect

/** All standing approvals for a workspace. */
export async function listForWorkspace(workspaceId: string): Promise<StandingApproval[]> {
    return db.select().from(standingApprovals).where(eq(standingApprovals.workspaceId, workspaceId))
}

export interface CreateStandingApprovalInput {
    workspaceId: string
    trigger: string
    actionPattern: string
    expiresAt?: Date
}

/** Create a standing approval; returns the created row. */
export async function create(input: CreateStandingApprovalInput): Promise<StandingApproval | undefined> {
    const [row] = await db.insert(standingApprovals).values(input).returning()
    return row
}

/** Delete a standing approval scoped to its workspace; returns the deleted row. */
export async function deleteScoped(id: string, workspaceId: string): Promise<StandingApproval | undefined> {
    const [deleted] = await db
        .delete(standingApprovals)
        .where(and(eq(standingApprovals.id, id), eq(standingApprovals.workspaceId, workspaceId)))
        .returning()
    return deleted
}
