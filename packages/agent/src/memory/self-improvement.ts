/**
 * Self-improvement loop — scans recent task outcomes to identify patterns
 * and proposes agent behavior improvements.
 *
 * Runs on a schedule (e.g. post-sprint or nightly) and:
 * 1. Loads recent work-ledger entries
 * 2. Uses the registry model to identify failure patterns and success patterns
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
import { workLedger } from '@plexo/db'
import { resolveModelFromEnv } from '../providers/registry.js'
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
    proposals: z.array(ImprovementProposalSchema).max(5),
})

type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runSelfImprovementCycle(params: {
    workspaceId: string
    lookbackDays?: number
}): Promise<{ proposals: number; applied: number }> {
    const { workspaceId, lookbackDays = 7 } = params

    logger.info({ workspaceId, lookbackDays }, 'Self-improvement cycle started')

    // Load recent ledger entries
    const since = new Date()
    since.setDate(since.getDate() - lookbackDays)

    const ledgerRows = await db.select({
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
        .limit(50)

    if (ledgerRows.length < 3) {
        logger.info({ workspaceId }, 'Not enough ledger data for improvement analysis — skipping')
        return { proposals: 0, applied: 0 }
    }

    const model = resolveModelFromEnv('claude-haiku-4-5')

    const ledgerSummary = ledgerRows.map((r) => ({
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
            prompt: `Analyze these recent task outcomes and identify up to 5 improvement patterns:\n${JSON.stringify(ledgerSummary, null, 2)}`,
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

            // Auto-apply simple tool_preference patterns to workspace preferences
            if (proposal.pattern_type === 'tool_preference' && proposal.proposed_change) {
                await learnPreference({
                    workspaceId,
                    key: 'tool_preference_note',
                    value: proposal.proposed_change,
                    observationConfidence: 0.55,
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
