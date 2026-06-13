// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Hub catalog data-access repository.
 *
 * arch-findings B1 — owns the extension_registry / extensions / extension_votes
 * reads and the vote upsert/delete. The route keeps manifest derivation, trust
 * inference, in-process filtering/sorting/pagination, and Map building. Catalog
 * filter predicates (type/search) are built here since they are pure SQL.
 */
import { db, sql, eq, and } from '@plexo/db'
import { extensionRegistry, extensions, extensionVotes } from '@plexo/db'

export interface VoteCountRow {
    extension_id: string
    upvotes: number
    downvotes: number
    score: number
    [k: string]: unknown
}

/** All extension vote-count rows. */
export async function getAllVoteCounts(): Promise<VoteCountRow[]> {
    return db.execute<VoteCountRow>(sql`
        SELECT extension_id, upvotes::int AS upvotes, downvotes::int AS downvotes, score::int AS score
        FROM extension_vote_counts
    `)
}

/** Vote-count row(s) for one extension. */
export async function getVoteCountsForExtension(extensionId: string): Promise<VoteCountRow[]> {
    return db.execute<VoteCountRow>(sql`
        SELECT extension_id, upvotes::int AS upvotes, downvotes::int AS downvotes, score::int AS score
        FROM extension_vote_counts
        WHERE extension_id = ${extensionId}
    `)
}

/** A user's votes across all extensions. */
export async function getUserVotes(userId: string): Promise<Array<{ extensionId: string; voteType: string }>> {
    return db
        .select({ extensionId: extensionVotes.extensionId, voteType: extensionVotes.voteType })
        .from(extensionVotes)
        .where(eq(extensionVotes.userId, userId))
}

/** A user's vote on one extension (0 or 1 row). */
export async function getUserVoteForExtension(userId: string, extensionId: string): Promise<Array<{ voteType: string }>> {
    return db
        .select({ voteType: extensionVotes.voteType })
        .from(extensionVotes)
        .where(and(eq(extensionVotes.userId, userId), eq(extensionVotes.extensionId, extensionId)))
        .limit(1)
}

/** Non-deprecated registry rows, optionally filtered by type and search text. */
export async function listRegistry(filter: { type?: string; q?: string }) {
    const conditions = [eq(extensionRegistry.deprecated, false)]
    if (filter.type && filter.type !== 'all') {
        conditions.push(sql`manifest->>'type' = ${filter.type}`)
    }
    if (filter.q && filter.q.trim()) {
        const pat = `%${filter.q.trim()}%`
        conditions.push(sql`(
            ${extensionRegistry.name} ILIKE ${pat}
            OR ${extensionRegistry.displayName} ILIKE ${pat}
            OR ${extensionRegistry.description} ILIKE ${pat}
        )`)
    }
    return db.select().from(extensionRegistry).where(and(...conditions))
}

/** Installed extensions for a workspace (status enrichment). */
export async function listInstalled(workspaceId: string): Promise<Array<{ id: string; name: string; enabled: boolean }>> {
    return db
        .select({ id: extensions.id, name: extensions.name, enabled: extensions.enabled })
        .from(extensions)
        .where(eq(extensions.workspaceId, workspaceId))
}

/** True when a registry entry with this name exists. */
export async function registryExists(name: string): Promise<boolean> {
    const rows = await db
        .select({ name: extensionRegistry.name })
        .from(extensionRegistry)
        .where(eq(extensionRegistry.name, name))
        .limit(1)
    return rows.length > 0
}

/** Remove a user's vote on an extension. */
export async function deleteUserVote(userId: string, extensionId: string): Promise<void> {
    await db
        .delete(extensionVotes)
        .where(and(eq(extensionVotes.userId, userId), eq(extensionVotes.extensionId, extensionId)))
}

/** Upsert a user's vote keyed on (user_id, extension_id). */
export async function upsertVote(extensionId: string, userId: string, voteType: 'up' | 'down'): Promise<void> {
    await db.execute(sql`
        INSERT INTO extension_votes (extension_id, user_id, vote_type, created_at, updated_at)
        VALUES (${extensionId}, ${userId}, ${voteType}, now(), now())
        ON CONFLICT (user_id, extension_id)
        DO UPDATE SET vote_type = EXCLUDED.vote_type, updated_at = now()
    `)
}
