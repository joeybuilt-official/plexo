// SPDX-License-Identifier: MIT
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
import { generateText } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { DrizzleImprovementLogStore, DrizzleWorkLedgerSampleStore } from '../memory.repository.js'
import type { ImprovementLogStore, WorkLedgerSampleStore, ImprovementLogEntry } from '../memory.ports.js'
import { resolveModelFromEnv } from '../providers/registry.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { learnPreference } from './preferences.js'

const logger = pino({ name: 'self-improvement' })

// ── Composition root + test seam ────────────────────────────────────────────
let improvementLogStore: ImprovementLogStore = new DrizzleImprovementLogStore()
let workLedgerSampleStore: WorkLedgerSampleStore = new DrizzleWorkLedgerSampleStore()

/** Swap the improvement log store (e.g. an in-memory fake in unit tests). */
export function setImprovementLogStore(next: ImprovementLogStore): void {
    improvementLogStore = next
}

/** Swap the work-ledger sample store (e.g. an in-memory fake in unit tests). */
export function setWorkLedgerSampleStore(next: WorkLedgerSampleStore): void {
    workLedgerSampleStore = next
}

// ── Schema ───────────────────────────────────────────────────────────────────

const ImprovementProposalSchema = z.object({
    pattern_type: z.enum(['failure_pattern', 'success_pattern', 'tool_preference', 'scope_adjustment', 'skill_proposal', 'extension_proposal', 'agent_proposal']),
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

    const rawLedger = await workLedgerSampleStore.selectOutcomeSamples(workspaceId, 200)

    let ledgerRows: LedgerRow[] = rawLedger

    // ── Fallback: if work_ledger is sparse, synthesise rows from completed tasks ──
    // This handles installs where memory writes were added after tasks already ran.
    if (rawLedger.length < 3) {
        logger.info({ workspaceId, ledgerCount: rawLedger.length }, 'work_ledger sparse — supplementing from completed tasks')

        const completedTasks = await workLedgerSampleStore.selectTaskOutcomeSamples(workspaceId, 50)

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

    // ── Cold start heuristics: deterministic rules when data is sparse ──
    // Avoids burning an LLM call when there isn't enough data to analyze.
    if (ledgerRows.length < 5) {
        logger.info({ workspaceId, count: ledgerRows.length }, 'Cold start mode — applying heuristic rules instead of LLM analysis')
        const heuristicProposals: ImprovementProposal[] = []

        // Early failure detection
        const failures = ledgerRows.filter(r => r.qualityScore != null && r.qualityScore < 0.5)
        if (failures.length > 0) {
            heuristicProposals.push({
                pattern_type: 'scope_adjustment',
                description: 'Early failure detected in workspace. Consider narrowing task scope for initial tasks to build confidence before tackling complex work.',
                evidence: failures.map(f => f.taskId?.slice(0, 8) ?? 'unknown'),
                proposed_change: 'Break large tasks into smaller, verifiable steps. Start with simpler tasks to establish working patterns.',
            })
        }

        // High token consumption warning
        const highTokenTasks = ledgerRows.filter(r => (r.tokensIn ?? 0) > 50_000)
        if (highTokenTasks.length > 0) {
            heuristicProposals.push({
                pattern_type: 'tool_preference',
                description: 'High token consumption detected in early tasks. Context may be overloaded.',
                evidence: highTokenTasks.map(f => f.taskId?.slice(0, 8) ?? 'unknown'),
                proposed_change: 'Consider adding workspace behavior rules to narrow context. Use the Context Library to curate what information the agent receives.',
            })
        }

        // All tasks succeeded — positive signal
        const successes = ledgerRows.filter(r => r.qualityScore != null && r.qualityScore >= 0.7)
        if (successes.length === ledgerRows.length && ledgerRows.length >= 2) {
            heuristicProposals.push({
                pattern_type: 'success_pattern',
                description: 'All early tasks succeeded. The workspace configuration appears solid.',
                evidence: successes.map(f => f.taskId?.slice(0, 8) ?? 'unknown'),
            })
        }

        if (heuristicProposals.length > 0) {
            let applied = 0
            for (const p of heuristicProposals) {
                try {
                    await improvementLogStore.appendProposals(workspaceId, [{
                        patternType: p.pattern_type,
                        description: p.description,
                        evidence: p.evidence ?? [],
                        proposedChange: p.proposed_change ?? null,
                    }])
                } catch (err) {
                    logger.error({ err, proposal: p }, 'Failed to store cold-start heuristic proposal')
                }
            }
            return { proposals: heuristicProposals.length, applied }
        }
        // Fall through to LLM analysis if no heuristics matched
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

    const ledgerSummary = stratified.map((r) => ({
        taskId: r.taskId?.slice(0, 8),
        type: r.type,
        qualityScore: r.qualityScore,
        calibration: r.calibration,
        wallClockMs: r.wallClockMs,
        tokensIn: r.tokensIn,
    }))

    const promptPayload = `Analyze these recent task outcomes (${stratified.length} tasks) and identify up to 5 improvement patterns.

Look specifically for:
1. Friction & Flail (Knowledge Gaps): If you see high tool call counts for simple file modifications or repeated failures, propose a 'skill_proposal' (e.g. standardizing a deploy script or framework convention).
2. Escalation & Danger (Safety Gaps): If you see raw bash scripts for API usage or dangerous commands requiring manual oversight, propose an 'extension_proposal'.
3. Context Overload (Delegation Gaps): If token usage is consistently nearing limits or there is a massive read-to-write imbalance, propose an 'agent_proposal'.
4. Standard behavior adjustments: 'failure_pattern', 'success_pattern', 'tool_preference', or 'scope_adjustment'.

If there are no clear patterns or no tasks, return an empty array for proposals.

Respond with ONLY valid JSON: { "proposals": [{ "pattern_type": "failure_pattern"|"success_pattern"|"tool_preference"|"scope_adjustment"|"skill_proposal"|"extension_proposal"|"agent_proposal", "description": string, "evidence": string[], "proposed_change": string }] }

${JSON.stringify(ledgerSummary, null, 2)}`

    const doCall = (model: import('../providers/registry.js').AnyLanguageModel) => generateText({
        model,
        system: 'You are an AI operations analyst. Given task performance data, identify patterns that an AI agent could use to improve. Focus heavily on identifying when a repetitive workflow needs a Skill, an ad-hoc or dangerous boundary crossing needs a deterministic extension, or when context saturation/multi-modal needs call for a specialized Agent.',
        prompt: promptPayload,
        abortSignal: AbortSignal.timeout(30_000),
    })

    let proposals: ImprovementProposal[] = []
    try {
        const { routeAndCall } = await import('../providers/router-v2/index.js')
        let textResult: Awaited<ReturnType<typeof doCall>> | null = null
        if (aiSettings) {
            try {
                textResult = await routeAndCall({ workspaceId, taskType: 'summarization', settings: aiSettings, doCall })
            } catch (err) {
                logger.warn({ err, workspaceId }, 'self-improvement: routeAndCall failed — env fallback')
            }
        }
        if (!textResult) {
            textResult = await doCall(resolveModelFromEnv())
        }
        const cleaned = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        proposals = ProposalsSchema.parse(JSON.parse(cleaned)).proposals
    } catch (err) {
        logger.error({ err }, 'LLM analysis failed in self-improvement cycle')
    }

    let applied = 0
    for (const proposal of proposals.slice(0, 5)) {
        try {
            await improvementLogStore.appendProposals(workspaceId, [{
                patternType: proposal.pattern_type,
                description: proposal.description,
                evidence: proposal.evidence ?? [],
                proposedChange: proposal.proposed_change ?? null,
            }])

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

export async function getImprovementLog(workspaceId: string, limit = 20): Promise<ImprovementLogEntry[]> {
    return improvementLogStore.listRecent(workspaceId, limit)
}
