// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Learning / outcomes data-access repository (read-only).
 *
 * owns the outcome-record and prompt-revision reads behind
 * the outcomes view and the revision-review (decision seam) UI. Both aggregate
 * across `outcome_records`, `prompt_revisions`, `cron_jobs`, and `tasks`,
 * scoped to a workspace via the routine OR task that owns each outcome. The
 * routes keep the view shaping (disagreement polarity, lesson grouping) and the
 * decision-seam orchestration. Only the SQL moves here; all filters are
 * parameterised and workspace scoping is preserved verbatim.
 */
import { and, or, eq, desc, inArray } from 'drizzle-orm'
import { db, promptRevisions, cronJobs, tasks, outcomeRecords } from '@plexo/db'

/** Recent outcome rows for a workspace (via routine OR task), newest first, capped. */
export function getOutcomesForWorkspace(workspaceId: string, limit: number) {
    return db
        .select({
            id: outcomeRecords.id,
            ts: outcomeRecords.ts,
            trigger: outcomeRecords.trigger,
            summary: outcomeRecords.summary,
            routineId: outcomeRecords.routineId,
            routineName: cronJobs.name,
            taskId: outcomeRecords.taskId,
            taskType: tasks.type,
            taskStatus: tasks.status,
            automatedOutcome: outcomeRecords.automatedOutcome,
            humanVerdict: outcomeRecords.humanVerdict,
        })
        .from(outcomeRecords)
        .leftJoin(cronJobs, eq(outcomeRecords.routineId, cronJobs.id))
        .leftJoin(tasks, eq(outcomeRecords.taskId, tasks.id))
        .where(or(eq(cronJobs.workspaceId, workspaceId), eq(tasks.workspaceId, workspaceId)))
        .orderBy(desc(outcomeRecords.ts))
        .limit(limit)
}

/** All prompt revisions for a workspace's routines (lesson distillation lookup). */
export function getRevisionsForWorkspace(workspaceId: string) {
    return db
        .select({
            id: promptRevisions.id,
            routineId: promptRevisions.routineId,
            version: promptRevisions.version,
            status: promptRevisions.status,
            rationale: promptRevisions.rationale,
            sourceOutcomeIds: promptRevisions.sourceOutcomeIds,
        })
        .from(promptRevisions)
        .innerJoin(cronJobs, eq(promptRevisions.routineId, cronJobs.id))
        .where(eq(cronJobs.workspaceId, workspaceId))
}

/** Pending prompt revisions for a workspace (revision-review feed). */
export function getPendingRevisionsForWorkspace(workspaceId: string) {
    return db
        .select({
            id: promptRevisions.id,
            routineId: promptRevisions.routineId,
            routineName: cronJobs.name,
            version: promptRevisions.version,
            proposedDiff: promptRevisions.proposedDiff,
            rationale: promptRevisions.rationale,
            sourceOutcomeIds: promptRevisions.sourceOutcomeIds,
            expiresAt: promptRevisions.expiresAt,
        })
        .from(promptRevisions)
        .innerJoin(cronJobs, eq(promptRevisions.routineId, cronJobs.id))
        .where(and(eq(cronJobs.workspaceId, workspaceId), eq(promptRevisions.status, 'pending')))
}

/** Source outcome summaries by id (resolves a revision's sourceOutcomeIds). */
export function getOutcomesByIds(ids: string[]) {
    return db
        .select({
            id: outcomeRecords.id,
            summary: outcomeRecords.summary,
            automatedOutcome: outcomeRecords.automatedOutcome,
            humanVerdict: outcomeRecords.humanVerdict,
        })
        .from(outcomeRecords)
        .where(inArray(outcomeRecords.id, ids))
}
