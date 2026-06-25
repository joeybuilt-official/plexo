// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Artifact-sharing data-access repository.
 *
 * owns the artifacts / artifact_versions / artifact_shares
 * reads and writes behind the share routes. The route keeps auth, workspace
 * access checks, share-id generation, expiry validation, URL shaping, and the
 * fire-and-forget view-count increment.
 */
import { eq, and, sql, isNull, desc } from 'drizzle-orm'
import { db } from '@plexo/db'
import { artifacts, artifactVersions, artifactShares } from '@plexo/db'

/** The owning workspace id for an artifact, or undefined. */
export async function getArtifactWorkspaceId(artifactId: string): Promise<string | undefined> {
    const [row] = await db.select({ workspaceId: artifacts.workspaceId })
        .from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
    return row?.workspaceId
}

/** Id of the active (non-revoked) share for an artifact, or undefined. */
export async function getActiveShareIdByArtifact(artifactId: string): Promise<string | undefined> {
    const [existing] = await db.select({ id: artifactShares.id })
        .from(artifactShares)
        .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
        .limit(1)
    return existing?.id
}

/** Insert a new share row. */
export async function createShare(values: typeof artifactShares.$inferInsert): Promise<void> {
    await db.insert(artifactShares).values(values)
}

/** Soft-revoke the active share(s) for an artifact. */
export async function revokeShareByArtifact(artifactId: string): Promise<void> {
    await db.update(artifactShares)
        .set({ revokedAt: new Date() })
        .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
}

/** Full active share row for an artifact, or undefined. */
export async function getActiveShareByArtifact(artifactId: string) {
    const [share] = await db.select()
        .from(artifactShares)
        .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
        .limit(1)
    return share
}

/** Full active share row by share id (public lookup), or undefined. */
export async function getActiveShareById(shareId: string) {
    const [share] = await db.select()
        .from(artifactShares)
        .where(and(eq(artifactShares.id, shareId), isNull(artifactShares.revokedAt)))
        .limit(1)
    return share
}

/** Increment a share's view count. Returns the promise for fire-and-forget use. */
export function incrementViewCount(shareId: string) {
    return db.update(artifactShares)
        .set({ viewCount: sql`${artifactShares.viewCount} + 1` })
        .where(eq(artifactShares.id, shareId))
}

/** Full artifact row by id, or undefined. */
export async function getArtifactById(artifactId: string) {
    const [artifact] = await db.select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1)
    return artifact
}

/** A pinned artifact version, or undefined. */
export async function getPinnedVersion(artifactId: string, version: number) {
    const [v] = await db.select()
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)))
        .limit(1)
    return v
}

/** The latest artifact version, or undefined. */
export async function getLatestVersion(artifactId: string) {
    const [v] = await db.select()
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifactId))
        .orderBy(desc(artifactVersions.version))
        .limit(1)
    return v
}
