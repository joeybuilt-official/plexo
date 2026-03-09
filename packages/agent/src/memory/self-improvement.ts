// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Self-improvement loop — scans recent task outcomes to identify patterns
 * and proposes agent behavior improvements.
 *
 * Runs on a schedule (e.g. post-sprint or nightly) and:
 * 1. Loads recent work-ledger entries (falls back to task_steps/tasks when sparse)
 * 2. Uses the configured workspace model to identify failure patterns and success patterns
 * 3. Stores proposals in agent_improvement_log
 * 4. Updates workspace preferences from high-confidence patterns
 *
 * This does NOT apply code changes to itself — it surfaces proposals
 * for the operator to review (one-way door gate for anything structural).
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { db, sql, desc, eq } from '@plexo/db'
import { workLedger, tasks } from '@plexo/db'
import { resolveModelFromEnv } from '../providers/registry.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { learnPreference } from './preferences.js'

const logger = pino({ name: 'self-improvement' })

// ── Schema ───────────────────────────────────────────────────────────────────

const ImprovementProposalSchema = z.object({
    pattern_type: z.enum(['failure_pattern', 'success_pattern', 'tool_preference', 'scope_adjustment']),
    description: z.string(),
    evidence: z.array(z.string()),
    proposed_change: z.string().optional(),
})

const ProposalsSchema = z.object({
    proposals: z.array(ImprovementProposalSchema).max(5).default([]).catch([]),
})

type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>

// ── Shared type for ledger-like rows ─────────────────────────────────────────

interface LedgerRow {
    taskId: string | null
    type: string
    qualityScore: number | null
    confidenceScore: number | null
    calibration: string | null
    tokensIn: number | null
    tokensOut: number | null
    deliverables: unknown
    wallClockMs: number | null
    completedAt: Date | null
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runSelfImprovementCycle(params: {
    workspaceId: string
    lookbackDays?: number
    aiSettings?: WorkspaceAISettings
}): Promise<{ proposals: number; applied: number }> {
    const { workspaceId, lookbackDays = 7, aiSettings } = params

    logger.info({ workspaceId, lookbackDays }, 'Self-improvement cycle started')

    // Load recent ledger entries
    const rawLedger = await db.select({
        taskId: workLedger.taskId,
        type: workLedger.type,
        qualityScore: workLedger.qualityScore,
        confidenceScore: workLedger.confidenceScore,
        calibration: workLedger.calibration,
        tokensIn: workLedger.tokensIn,
        tokensOut: workLedger.tokensOut,
        deliverables: workLedger.deliverables,
        wallClockMs: workLedger.wallClockMs,
        completedAt: workLedger.completedAt,
    }).from(workLedger)
        .where(eq(workLedger.workspaceId, workspaceId))
        .orderBy(desc(workLedger.completedAt))
        .limit(200)

    let ledgerRows: LedgerRow[] = rawLedger

    // ── Fallback: if work_ledger is sparse, synthesise rows from completed tasks ──
    // This handles installs where memory writes were added after tasks already ran.
    if (rawLedger.length < 3) {
        logger.info({ workspaceId, ledgerCount: rawLedger.length }, 'work_ledger sparse — supplementing from completed tasks')

        const completedTasks = await db.select({
            id: tasks.id,
            type: tasks.type,
            qualityScore: tasks.qualityScore,
            confidenceScore: tasks.confidenceScore,
            tokensIn: tasks.tokensIn,
            tokensOut: tasks.tokensOut,
            outcomeSummary: tasks.outcomeSummary,
            completedAt: tasks.completedAt,
        }).from(tasks)
            .where(eq(tasks.workspaceId, workspaceId))
            .orderBy(desc(tasks.completedAt))
            .limit(50)

        const syntheticRows: LedgerRow[] = completedTasks.map((t) => ({
            taskId: t.id,
            type: t.type,
            qualityScore: t.qualityScore,
            confidenceScore: t.confidenceScore,
            calibration: null,
            tokensIn: t.tokensIn,
            tokensOut: t.tokensOut,
            deliverables: [],
            wallClockMs: null,
            completedAt: t.completedAt,
        }))

        // Merge: real ledger rows first, deduplicated by taskId
        const seen = new Set(rawLedger.map((r) => r.taskId))
        ledgerRows = [
            ...rawLedger,
            ...syntheticRows.filter((r) => !seen.has(r.taskId)),
        ]
    }

    if (ledgerRows.length === 0) {
        logger.info({ workspaceId }, 'No task data available for improvement analysis — run a task first')
        return { proposals: 0, applied: 0 }
    }

    // Stratify by task type (max 8 per type) to prevent pattern analysis from
    // overfitting to whichever type dominated the recent history.
    const byType = new Map<string, LedgerRow[]>()
    for (const r of ledgerRows) {
        const t = r.type ?? 'unknown'
        const list = byType.get(t) ?? []
        if (list.length < 8) {
            list.push(r)
            byType.set(t, list)
        }
    }
    const stratified = Array.from(byType.values()).flat()

    // Resolve model — prefer workspace-configured model, fall back to env
    let model: import('../providers/registry.js').AnyLanguageModel
    if (aiSettings) {
        try {
            const { resolveModel } = await import('../providers/registry.js')
            const resolved = await resolveModel('summarization', aiSettings, workspaceId)
            model = resolved.model
        } catch {
            model = resolveModelFromEnv('claude-haiku-4-5')
        }
    } else {
        model = resolveModelFromEnv('claude-haiku-4-5')
    }

    const ledgerSummary = stratified.map((r) => ({
        taskId: r.taskId?.slice(0, 8),
        type: r.type,
        qualityScore: r.qualityScore,
        calibration: r.calibration,
        wallClockMs: r.wallClockMs,
        tokensIn: r.tokensIn,
    }))

    let proposals: ImprovementProposal[] = []
    try {
        const result = await generateObject({
            model,
            schema: ProposalsSchema,
            system: 'You are an AI operations analyst. Given task performance data, identify patterns that an AI agent could use to improve.',
            prompt: `Analyze these recent task outcomes (${stratified.length} tasks) and identify up to 5 improvement patterns. If there are no clear patterns or no tasks, return an empty array for proposals:\n${JSON.stringify(ledgerSummary, null, 2)}`,
            maxOutputTokens: 1024,
        })
        proposals = result.object.proposals
    } catch (err) {
        logger.error({ err }, 'LLM analysis failed in self-improvement cycle')
    }

    // Store proposals
    let applied = 0
    for (const proposal of proposals.slice(0, 5)) {
        try {
            await db.execute(sql`
        INSERT INTO agent_improvement_log
          (workspace_id, pattern_type, description, evidence, proposed_change, created_at)
        VALUES (
          ${workspaceId}::uuid,
          ${proposal.pattern_type},
          ${proposal.description},
          ${JSON.stringify(proposal.evidence ?? [])}::jsonb,
          ${proposal.proposed_change ?? null},
          now()
        )
      `)

            // Auto-apply tool_preference patterns only above a meaningful confidence floor.
            if (proposal.pattern_type === 'tool_preference' && proposal.proposed_change) {
                await learnPreference({
                    workspaceId,
                    key: 'tool_preference_note',
                    value: proposal.proposed_change,
                    observationConfidence: 0.75,
                })
                applied++
            }
        } catch (err) {
            logger.error({ err, proposal }, 'Failed to store improvement proposal')
        }
    }

    logger.info({ workspaceId, proposals: proposals.length, applied }, 'Self-improvement cycle complete')
    return { proposals: proposals.length, applied }
}

// ── Retrieve log ──────────────────────────────────────────────────────────────

export async function getImprovementLog(workspaceId: string, limit = 20) {
    return db.execute<{
        id: string
        pattern_type: string
        description: string
        evidence: unknown
        proposed_change: string | null
        applied: boolean
        created_at: Date
    }>(sql`
    SELECT id, pattern_type, description, evidence, proposed_change, applied, created_at
    FROM agent_improvement_log
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)
}
