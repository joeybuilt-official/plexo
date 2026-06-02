// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outcomes / learning read view.
 *
 * GET /api/v1/outcomes?workspaceId=  — recent outcome records for the workspace,
 * each pairing the automated outcome with the human verdict, flagging where the
 * two disagree, and surfacing any prompt revision (lesson) distilled from that
 * outcome. Read-only; no migration. When distillation is off (DISTILL_ENABLED=
 * false) revisions are sparse, so `lessons` is usually empty — the view handles
 * that without ceremony.
 */

import { Router, type Router as ExpressRouter } from 'express'
import { db, and, or, eq, desc, promptRevisions, cronJobs, tasks, outcomeRecords } from '@plexo/db'
import { logger } from '../logger.js'

const MAX_OUTCOMES = 200

// ── Read model ───────────────────────────────────────────────────────────────

export interface LinkedLesson {
    revisionId: string
    routineId: string
    version: number
    status: string
    rationale: string
}

export interface OutcomeRow {
    id: string
    ts: Date
    trigger: string
    summary: string | null
    routineId: string | null
    routineName: string | null
    taskId: string | null
    taskType: string | null
    taskStatus: string | null
    automatedOutcome: string | null
    humanVerdict: string | null
}

export interface OutcomeView extends OutcomeRow {
    /** automated and human assessments are both present and oppose each other. */
    disagreement: boolean
    /** prompt revisions distilled from this outcome (empty when none / distill off). */
    lessons: LinkedLesson[]
}

/**
 * Polarity of each side maps the two distinct vocabularies onto one axis so a
 * verdict pair can be compared: automated 'complete'/'failed' and human
 * 'accept'/'reject'. Unknown/null values yield null (→ no disagreement claimed).
 */
function automatedPolarity(v: string | null): boolean | null {
    if (v === 'complete') return true
    if (v === 'failed') return false
    return null
}

function humanPolarity(v: string | null): boolean | null {
    if (v === 'accept') return true
    if (v === 'reject') return false
    return null
}

function isDisagreement(automatedOutcome: string | null, humanVerdict: string | null): boolean {
    const a = automatedPolarity(automatedOutcome)
    const h = humanPolarity(humanVerdict)
    if (a === null || h === null) return false
    return a !== h
}

/** Pure — pairs each outcome with its verdict assessment + distilled lessons. Exported for tests. */
export function buildOutcomesView(rows: OutcomeRow[], lessonsByOutcomeId: Map<string, LinkedLesson[]>): OutcomeView[] {
    return rows.map((row) => ({
        ...row,
        disagreement: isDisagreement(row.automatedOutcome, row.humanVerdict),
        lessons: lessonsByOutcomeId.get(row.id) ?? [],
    }))
}

export const outcomesRouter: ExpressRouter = Router()

outcomesRouter.get('/', async (req, res) => {
    const workspaceId = (req.query as Record<string, string>).workspaceId
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query param required' } })
        return
    }

    try {
        // An outcome belongs to the workspace via its routine OR its task.
        const rows = (await db
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
            .limit(MAX_OUTCOMES)) as OutcomeRow[]

        const outcomeIds = new Set(rows.map((r) => r.id))

        // Revisions distilled from these outcomes (sparse when distillation off).
        const lessonsByOutcomeId = new Map<string, LinkedLesson[]>()
        if (outcomeIds.size > 0) {
            const revisions = await db
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

            for (const r of revisions) {
                const lesson: LinkedLesson = {
                    revisionId: r.id,
                    routineId: r.routineId,
                    version: r.version,
                    status: r.status,
                    rationale: r.rationale,
                }
                for (const oid of r.sourceOutcomeIds ?? []) {
                    if (!outcomeIds.has(oid)) continue
                    const list = lessonsByOutcomeId.get(oid)
                    if (list) list.push(lesson)
                    else lessonsByOutcomeId.set(oid, [lesson])
                }
            }
        }

        res.json({ items: buildOutcomesView(rows, lessonsByOutcomeId) })
    } catch (err) {
        logger.error({ err, workspaceId }, 'outcomes list failed')
        res.status(500).json({ error: { code: 'LIST_FAILED', message: 'Internal error' } })
    }
})
