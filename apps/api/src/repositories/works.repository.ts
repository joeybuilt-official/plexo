// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Works (cross-workspace artifact list) data-access repository.
 *
 * arch-findings B1 — owns the artifacts/artifactVersions/tasks join behind
 * GET /api/v1/works. The route keeps validation, the cap clamp, and response
 * shaping. Workspace scoping is enforced inside the query.
 */
import { db, desc, asc, eq, and, sql } from '@plexo/db'
import { artifacts, artifactVersions, tasks } from '@plexo/db'

export interface ListWorksFilter {
    workspaceId: string
    kind?: string
    source?: string
    cursor?: string
    sort?: string
    cap: number
}

/** Paginated artifact list with content length + originating-task metadata. */
export async function listWorks(filter: ListWorksFilter) {
    const { workspaceId, kind, source, cursor, sort, cap } = filter

    const conditions = [eq(artifacts.workspaceId, workspaceId)]
    if (kind) conditions.push(eq(artifacts.kind, kind))
    if (source) conditions.push(sql`${tasks.source} = ${source}`)
    if (cursor) conditions.push(sql`${artifacts.id} < ${cursor}`)

    const orderBy = sort === 'oldest'
        ? [asc(artifacts.createdAt)]
        : sort === 'largest'
            ? [desc(sql`length(${artifactVersions.content})`)]
            : [desc(artifacts.createdAt)]

    return db.select({
        id:             artifacts.id,
        filename:       artifacts.filename,
        kind:           artifacts.kind,
        type:           artifacts.type,
        meta:           artifacts.meta,
        currentVersion: artifacts.currentVersion,
        taskId:         artifacts.taskId,
        projectId:      artifacts.projectId,
        createdAt:      artifacts.createdAt,
        updatedAt:      artifacts.updatedAt,
        contentLength:  sql<number>`length(${artifactVersions.content})`,
        taskSource:     tasks.source,
        taskSummary:    tasks.outcomeSummary,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.version, artifacts.currentVersion),
    ))
    .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(cap)
}
