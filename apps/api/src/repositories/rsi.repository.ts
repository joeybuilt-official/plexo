// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * RSI (recursive self-improvement) proposals data-access repository.
 *
 * arch-findings B1 — owns the rsi_proposals / rsi_test_results reads and the
 * approve/reject status writes. The route keeps validation, the non-fatal
 * shadow-test orchestration, analytics emits, and the aggregate summary math.
 * All queries are workspace-scoped (object-level authz).
 */
import { db, rsiProposals, rsiTestResults, eq, and, desc } from '@plexo/db'

/** Newest 50 proposals for a workspace. */
export async function listProposals(workspaceId: string) {
    return db.select()
        .from(rsiProposals)
        .where(eq(rsiProposals.workspaceId, workspaceId))
        .orderBy(desc(rsiProposals.createdAt))
        .limit(50)
}

/** Approve a workspace-scoped proposal, returning the updated row. */
export async function approveProposal(proposalId: string, workspaceId: string) {
    const [updated] = await db.update(rsiProposals)
        .set({ status: 'approved', approvedAt: new Date() })
        .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
        .returning()
    return updated
}

/** Reject a workspace-scoped proposal, returning the updated row. */
export async function rejectProposal(proposalId: string, workspaceId: string) {
    const [updated] = await db.update(rsiProposals)
        .set({ status: 'rejected', rejectedAt: new Date() })
        .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
        .returning()
    return updated
}

/** Verify a proposal belongs to a workspace ({id} or undefined). */
export async function getProposalScoped(proposalId: string, workspaceId: string): Promise<{ id: string } | undefined> {
    const [proposal] = await db.select({ id: rsiProposals.id })
        .from(rsiProposals)
        .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
        .limit(1)
    return proposal
}

/** Newest 50 test results for a proposal. */
export async function listTestResults(proposalId: string) {
    return db.select()
        .from(rsiTestResults)
        .where(eq(rsiTestResults.proposalId, proposalId))
        .orderBy(desc(rsiTestResults.createdAt))
        .limit(50)
}
