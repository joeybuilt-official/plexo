// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workbench-pins data-access repository.
 *
 * owns the workbench_pins reads/writes and the joined
 * pin+artifact+current-version read. The route keeps auth, validation,
 * workspace-access checks, cross-workspace pin guards, and response shaping.
 * All queries are user- and/or workspace-scoped (object-level authz).
 */
import { eq, and, asc, desc } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workbenchPins, artifacts, artifactVersions } from '@plexo/db'

/** A user's pinned works for a workspace, with current-version content inlined. */
export async function listPinsWithContent(userId: string, workspaceId: string) {
    return db.select({
        pinId:          workbenchPins.id,
        position:       workbenchPins.position,
        pinnedAt:       workbenchPins.pinnedAt,
        workId:         workbenchPins.workId,
        filename:       artifacts.filename,
        kind:           artifacts.kind,
        type:           artifacts.type,
        meta:           artifacts.meta,
        currentVersion: artifacts.currentVersion,
        updatedAt:      artifacts.updatedAt,
        content:        artifactVersions.content,
    })
    .from(workbenchPins)
    .innerJoin(artifacts, eq(artifacts.id, workbenchPins.workId))
    .innerJoin(artifactVersions, and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.version, artifacts.currentVersion),
    ))
    .where(and(
        eq(workbenchPins.userId, userId),
        eq(workbenchPins.workspaceId, workspaceId),
    ))
    .orderBy(asc(workbenchPins.position), desc(workbenchPins.pinnedAt))
}

/** {id,workspaceId} of an artifact, for the cross-workspace pin guard. */
export async function getArtifactWorkspace(workId: string): Promise<{ id: string; workspaceId: string } | undefined> {
    const [art] = await db.select({ id: artifacts.id, workspaceId: artifacts.workspaceId })
        .from(artifacts)
        .where(eq(artifacts.id, workId))
        .limit(1)
    return art
}

/** Insert a pin (idempotent on user_id+work_id); returns the new row or undefined on conflict. */
export async function insertPinIgnore(userId: string, workspaceId: string, workId: string) {
    const [row] = await db.insert(workbenchPins)
        .values({ userId, workspaceId, workId, position: 0 })
        .onConflictDoNothing()
        .returning()
    return row
}

/** Existing pin for (user, work). */
export async function getPin(userId: string, workId: string) {
    const [existing] = await db.select()
        .from(workbenchPins)
        .where(and(eq(workbenchPins.userId, userId), eq(workbenchPins.workId, workId)))
        .limit(1)
    return existing
}

/** Delete a user's pin by id; returns the deleted ids. */
export async function deletePin(id: string, userId: string): Promise<Array<{ id: string }>> {
    return db.delete(workbenchPins)
        .where(and(eq(workbenchPins.id, id), eq(workbenchPins.userId, userId)))
        .returning({ id: workbenchPins.id })
}

/** Update a user's pin position; returns the updated row or undefined. */
export async function updatePinPosition(id: string, userId: string, position: number) {
    const [row] = await db.update(workbenchPins)
        .set({ position })
        .where(and(eq(workbenchPins.id, id), eq(workbenchPins.userId, userId)))
        .returning()
    return row
}
