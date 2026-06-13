// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tasks data-access repository.
 *
 * arch-findings B1 — owns the `tasks`, `task_steps`, `plexo_ops_task_events`,
 * `artifacts`, and `artifact_versions` reads/writes plus the cost/status-count
 * raw SQL used by the Tasks API. Every queue/executor side-effect stays in the
 * route: queue push/claim (`push`/`list`/`cancel`), executor aborts
 * (`cancelActiveTask`), checkpoint resume (`getResumeStep`), one-way-door
 * decisions, SSE emits, analytics/audit, conversation logging, kind inference,
 * filesystem/puppeteer/docx export, and all workspace-access / ownership
 * checks. Only the SQL moves here. Workspace scoping and object-level
 * ownership filters are preserved verbatim; all filters stay parameterised.
 */
import { db, desc, asc, eq, and, gte, sql } from '@plexo/db'
import { tasks, taskSteps, plexoOpsTaskEvents, artifacts, artifactVersions } from '@plexo/db'

type Task = typeof tasks.$inferSelect

/** Workspace id for a task (cheap scoping lookup), or undefined. */
export async function getTaskWorkspaceId(taskId: string): Promise<{ workspaceId: string } | undefined> {
    const [row] = await db.select({ workspaceId: tasks.workspaceId })
        .from(tasks).where(eq(tasks.id, taskId)).limit(1)
    return row
}

/** Full task row by id, or undefined. */
export async function getTaskById(id: string): Promise<Task | undefined> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return task
}

/** Workspace id + status for a task, or undefined. */
export async function getTaskWorkspaceAndStatus(id: string): Promise<{ workspaceId: string; status: string } | undefined> {
    const [existing] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status })
        .from(tasks).where(eq(tasks.id, id)).limit(1)
    return existing
}

/** Workspace id + status + context for a task, or undefined. */
export async function getTaskWorkspaceStatusContext(id: string): Promise<{ workspaceId: string; status: string; context: unknown } | undefined> {
    const [task] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status, context: tasks.context })
        .from(tasks).where(eq(tasks.id, id)).limit(1)
    return task
}

/** Workspace id + status + context + type for a task (clarification respond), or undefined. */
export async function getTaskWorkspaceStatusContextType(id: string): Promise<{ workspaceId: string; status: string; context: unknown; type: string } | undefined> {
    const [task] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status, context: tasks.context, type: tasks.type })
        .from(tasks).where(eq(tasks.id, id)).limit(1)
    return task
}

/** Workspace id + context for a task scoped to a workspace (Code Mode cross-tenant guard), or undefined. */
export async function getTaskWorkspaceContextScoped(id: string, workspaceId: string): Promise<{ workspaceId: string; context: unknown } | undefined> {
    const [task] = await db.select({ workspaceId: tasks.workspaceId, context: tasks.context })
        .from(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId))).limit(1)
    return task
}

/** Steps for a task (full rows), ordered by step number, capped. */
export function selectTaskSteps(taskId: string) {
    return db.select().from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.stepNumber)
        .limit(500)
}

/** Lifecycle timeline events for a task, scoped by task AND workspace (defense in depth). */
export function selectTaskEvents(taskId: string, workspaceId: string) {
    return db.select({
        id: plexoOpsTaskEvents.id,
        eventType: plexoOpsTaskEvents.eventType,
        fromState: plexoOpsTaskEvents.fromState,
        toState: plexoOpsTaskEvents.toState,
        metadata: plexoOpsTaskEvents.metadata,
        recordedAt: plexoOpsTaskEvents.recordedAt,
    }).from(plexoOpsTaskEvents)
        .where(and(
            eq(plexoOpsTaskEvents.taskId, taskId),
            eq(plexoOpsTaskEvents.workspaceId, workspaceId),
        ))
        .orderBy(asc(plexoOpsTaskEvents.recordedAt))
        // hard cap; UI must paginate if exceeded
        .limit(200)
}

/** Raw step-state debug rows for a task, ordered by step number, capped. */
export async function getRawTaskSteps(taskId: string, limit: number) {
    return db.select({
        stepNumber: taskSteps.stepNumber,
        toolCalls: taskSteps.toolCalls,
        stepState: taskSteps.stepState,
        createdAt: taskSteps.createdAt,
    })
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.stepNumber)
        .limit(limit)
}

/** DB-backed artifacts for a task joined to their current version content (Phase 4). */
export async function getTaskArtifacts(taskId: string) {
    return db.select({
        id: artifacts.id,
        filename: artifacts.filename,
        type: artifacts.type,
        kind: artifacts.kind,
        meta: artifacts.meta,
        currentVersion: artifacts.currentVersion,
        updatedAt: artifacts.updatedAt,
        content: artifactVersions.content,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.version, artifacts.currentVersion)
    ))
    .where(eq(artifacts.taskId, taskId))
}

/** Version history (metadata only) for an artifact, newest first. */
export async function getArtifactVersions(artifactId: string) {
    return db.select({
        version: artifactVersions.version,
        changeDescription: artifactVersions.changeDescription,
        createdAt: artifactVersions.createdAt,
        // Don't return full content in list
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version))
}

/** A specific version of an artifact (full row), or undefined. */
export async function getArtifactVersion(artifactId: string, versionNum: number) {
    const [ver] = await db.select()
        .from(artifactVersions)
        .where(and(
            eq(artifactVersions.artifactId, artifactId),
            eq(artifactVersions.version, versionNum)
        ))
        .limit(1)
    return ver
}

/** Task status counts grouped by status for a workspace. */
export async function getTaskStatusCounts(workspaceId: string) {
    return db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*) as count
      FROM tasks
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `)
}

/** Current ISO-week cost row (api_cost_tracking), or undefined. */
export async function getWeekCost(workspaceId: string): Promise<{ cost_usd: string | null } | undefined> {
    const [weekCostRow] = await db.execute<{ cost_usd: string | null }>(sql`
        SELECT cost_usd
        FROM api_cost_tracking
        WHERE workspace_id = ${workspaceId}::uuid
          AND week_start = date_trunc('week', NOW())::date
        LIMIT 1
    `)
    return weekCostRow
}

/** All-time cost sum (work_ledger), or undefined. */
export async function getAllTimeCost(workspaceId: string): Promise<{ total: string } | undefined> {
    const [allTimeCostRow] = await db.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM work_ledger
        WHERE workspace_id = ${workspaceId}::uuid
    `)
    return allTimeCostRow
}

/** Artifact id + meta + owning task id by id, or undefined. */
export async function getArtifactForMeta(artifactId: string): Promise<{ id: string; meta: unknown; taskId: string } | undefined> {
    const [art] = await db.select({ id: artifacts.id, meta: artifacts.meta, taskId: artifacts.taskId })
        .from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
    return art
}

/** Shallow-merge a meta JSONB patch onto an artifact, returning the new meta. */
export async function updateArtifactMeta(artifactId: string, merged: Record<string, unknown>): Promise<{ meta: unknown } | undefined> {
    const [updated] = await db.update(artifacts)
        .set({ meta: merged, updatedAt: new Date() })
        .where(eq(artifacts.id, artifactId))
        .returning({ meta: artifacts.meta })
    return updated
}

/** Task id by id, scoped to workspace (existence check for inject), or undefined. */
export async function getTaskIdScoped(id: string, workspaceId: string): Promise<{ id: string } | undefined> {
    const [task] = await db.select({ id: tasks.id })
        .from(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId))).limit(1)
    return task
}

/** Task id + status by id, scoped to workspace (stream gate), or undefined. */
export async function getTaskIdStatusScoped(id: string, workspaceId: string): Promise<{ id: string; status: string } | undefined> {
    const [task] = await db.select({ id: tasks.id, status: tasks.status })
        .from(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId))).limit(1)
    return task
}

/** Task status only by id, or undefined (stream terminal-state poll). */
export async function getTaskStatus(id: string): Promise<{ status: string } | undefined> {
    const [current] = await db.select({ status: tasks.status })
        .from(tasks).where(eq(tasks.id, id)).limit(1)
    return current
}

/** Highest step_number for a task, or undefined (inject sequencing). */
export async function getMaxStepNumber(taskId: string): Promise<{ stepNumber: number } | undefined> {
    const [maxRow] = await db.select({ stepNumber: taskSteps.stepNumber })
        .from(taskSteps).where(eq(taskSteps.taskId, taskId))
        .orderBy(desc(taskSteps.stepNumber)).limit(1)
    return maxRow
}

/** Insert an injected task step; returns its step_number, or undefined. */
export async function insertTaskStep(values: typeof taskSteps.$inferInsert): Promise<{ stepNumber: number } | undefined> {
    const [inserted] = await db.insert(taskSteps).values(values)
        .returning({ stepNumber: taskSteps.stepNumber })
    return inserted
}

/** Full step rows for a task with step_number ≥ minStepNumber, ordered (stream poll). */
export async function getStepsSince(taskId: string, minStepNumber: number) {
    return db.select().from(taskSteps)
        .where(and(eq(taskSteps.taskId, taskId), gte(taskSteps.stepNumber, minStepNumber)))
        .orderBy(taskSteps.stepNumber)
}
