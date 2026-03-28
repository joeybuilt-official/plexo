import { db, workLedger, rsiProposals, workspaces, sql } from '@plexo/db'
import { eq, gte, and, desc } from 'drizzle-orm'
import { eventBus, TOPICS } from '../plugins/event-bus.js'
const logger = console

export type AnomalyType =
    | 'quality_degradation'
    | 'confidence_skew'
    | 'cost_spikes'
    | 'tool_failure_pattern'
    | 'routing_inefficiency'
    | 'correction_surge'

export interface RSIAnomaly {
    type: AnomalyType
    hypothesis: string
    proposedChange: Record<string, unknown>
    risk: 'low' | 'medium' | 'high'
}

/**
 * Scan work_ledger over a 14-day window for statistical anomalies per workspace.
 */
export async function runRSIMonitor() {
    logger.info({ event: 'rsi_scan_start' }, 'Starting RSI monitor scan')
    const activeWorkspaces = await db.select({ id: workspaces.id }).from(workspaces).limit(500)

    let totalProposals = 0

    for (const ws of activeWorkspaces) {
        const count = await scanWorkspace(ws.id)
        totalProposals += count
    }

    logger.info({ event: 'rsi_scan_complete', totalProposals }, 'RSI monitor scan completed')
    return totalProposals
}

async function scanWorkspace(workspaceId: string): Promise<number> {
    const fourteenDaysAgo = new Date()
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

    // aggregate all relevant completed tasks for this workspace — select only needed columns
    const recentTasks = await db
        .select({
            qualityScore: workLedger.qualityScore,
            calibration: workLedger.calibration,
            costUsd: workLedger.costUsd,
            completedAt: workLedger.completedAt,
            tokensIn: workLedger.tokensIn,
            tokensOut: workLedger.tokensOut,
            deliverables: workLedger.deliverables,
        })
        .from(workLedger)
        .where(
            and(
                eq(workLedger.workspaceId, workspaceId),
                gte(workLedger.completedAt, fourteenDaysAgo)
            )
        )
        .limit(1000)

    if (recentTasks.length < 3) return 0 // Lowered from 5 to 3 for cold start (Phase 4)

    // Count corrections in the window for correction_surge detection
    let correctionCount = 0
    try {
        const [row] = await db.execute<{ count: number }>(sql`
            SELECT count(*)::int as count FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND type = 'pattern'
              AND metadata->>'correctionType' IS NOT NULL
              AND created_at >= ${fourteenDaysAgo}
        `)
        correctionCount = row?.count ?? 0
    } catch { /* memory_entries table may not have correction entries yet */ }

    const proposals = detectAnomalies(recentTasks, correctionCount)

    let inserted = 0
    if (proposals.length === 0) return 0

    // Batch-fetch existing pending proposals to avoid N+1 duplicate checks
    const existingProposals = await db.select({
        anomalyType: rsiProposals.anomalyType,
    }).from(rsiProposals).where(
        and(
            eq(rsiProposals.workspaceId, workspaceId),
            eq(rsiProposals.status, 'pending')
        )
    ).limit(100)
    const existingTypes = new Set(existingProposals.map(p => p.anomalyType))

    // Persist discovered proposals allowing shadow testing
    for (const proposal of proposals) {
        if (!existingTypes.has(proposal.type)) {
            await db.insert(rsiProposals).values({
                workspaceId,
                anomalyType: proposal.type,
                hypothesis: proposal.hypothesis,
                proposedChange: proposal.proposedChange,
                risk: proposal.risk,
            })
            existingTypes.add(proposal.type) // prevent duplicates within same batch
            inserted++
            logger.info({ event: 'rsi_proposal_emitted', workspaceId, type: proposal.type }, 'RSI generated new proposal hypothesis')
            eventBus.publish(TOPICS.RSI_PROPOSAL_CREATED, { workspaceId, type: proposal.type, hypothesis: proposal.hypothesis })
        }
    }

    return inserted
}

interface TaskRecord {
    qualityScore?: number | null
    calibration?: string | null
    costUsd?: number | null
    completedAt?: Date | null
    tokensIn?: number | null
    tokensOut?: number | null
    deliverables?: unknown
}

export function detectAnomalies(recentTasks: TaskRecord[], correctionCount = 0): RSIAnomaly[] {
    const proposals: RSIAnomaly[] = []

    // 1. Check for 'quality_degradation' across tasks with recorded scores
    const tasksWithScores = recentTasks.filter(t => t.qualityScore !== null)
    if (tasksWithScores.length >= 5) {
        const avgQuality = tasksWithScores.reduce((acc, t) => acc + (t.qualityScore || 0), 0) / tasksWithScores.length
        if (avgQuality < 6.0) {
            proposals.push({
                type: 'quality_degradation',
                hypothesis: `Average quality dropped to ${avgQuality.toFixed(1)}/10 over the last 14 days. Verification criteria may be too loose.`,
                proposedChange: { action: 'refine_verification_criteria', target: 'soul_protocol' },
                risk: 'medium'
            })
        }
    }

    // 2. Check for 'confidence_skew' (over-confident predictions)
    const tasksWithCalibration = recentTasks.filter(t => !!t.calibration)
    if (tasksWithCalibration.length >= 5) {
        const overconfidentTasks = tasksWithCalibration.filter(t => t.calibration === 'over')
        const overconfidentRatio = overconfidentTasks.length / tasksWithCalibration.length
        
        if (overconfidentRatio > 0.4) {
            proposals.push({
                type: 'confidence_skew',
                hypothesis: `${(overconfidentRatio * 100).toFixed(0)}% of recent tasks failed to meet initial confidence projections. Unknowns enumeration should be reinforced.`,
                proposedChange: { action: 'insert_unknowns_enumeration', target: 'plan_phase' },
                risk: 'low'
            })
        }
    }

    // 3. Cost spikes — compare current window avg against prior 30-day window avg
    const costTasks = recentTasks.filter(t => t.costUsd && t.costUsd > 0.0)
    if (costTasks.length >= 5) {
        const currentAvgCost = costTasks.reduce((acc, t) => acc + (t.costUsd || 0), 0) / costTasks.length

        // Derive historical baseline from the prior window in the dataset (the oldest half)
        const sorted = [...costTasks].sort((a, b) =>
            (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0)
        )
        const halfPoint = Math.floor(sorted.length / 2)
        const priorHalf = sorted.slice(0, halfPoint)
        const recentHalf = sorted.slice(halfPoint)

        if (priorHalf.length >= 2 && recentHalf.length >= 2) {
            const priorAvg = priorHalf.reduce((s, t) => s + (t.costUsd ?? 0), 0) / priorHalf.length
            const recentAvg = recentHalf.reduce((s, t) => s + (t.costUsd ?? 0), 0) / recentHalf.length

            if (priorAvg > 0 && recentAvg > priorAvg * 2.0) {
                proposals.push({
                    type: 'cost_spikes',
                    hypothesis: `Average task cost spiked to $${recentAvg.toFixed(2)} vs prior avg $${priorAvg.toFixed(2)}. Clarification loops may be unbounded.`,
                    proposedChange: { action: 'cap_clarification_loops', target: 'soul_protocol', threshold: 2 },
                    risk: 'high'
                })
            }
        }
    }

    // 4. Tool failure patterns — any tool with >30% failure rate
    const toolStats = new Map<string, { total: number; failed: number }>()
    for (const t of recentTasks) {
        const delivs = Array.isArray(t.deliverables) ? t.deliverables : []
        for (const d of delivs) {
            const dd = d as { tool?: string; outcome?: string }
            if (dd.tool) {
                const stats = toolStats.get(dd.tool) ?? { total: 0, failed: 0 }
                stats.total++
                if (dd.outcome === 'error' || dd.outcome === 'tool_timeout') stats.failed++
                toolStats.set(dd.tool, stats)
            }
        }
    }
    for (const [tool, stats] of toolStats) {
        if (stats.total >= 5 && stats.failed / stats.total > 0.3) {
            proposals.push({
                type: 'tool_failure_pattern',
                hypothesis: `Tool "${tool}" has a ${((stats.failed / stats.total) * 100).toFixed(0)}% failure rate (${stats.failed}/${stats.total} calls). Consider a behavior rule to prefer alternatives.`,
                proposedChange: { action: 'add_tool_preference', tool, failureRate: stats.failed / stats.total },
                risk: 'low',
            })
        }
    }

    // 5. Routing inefficiency — high tokens + low quality = wrong model for the job
    const tasksWithTokensAndQuality = recentTasks.filter(t =>
        t.tokensIn != null && t.tokensOut != null && t.qualityScore != null
    )
    if (tasksWithTokensAndQuality.length >= 5) {
        const totalTokens = tasksWithTokensAndQuality.map(t => (t.tokensIn ?? 0) + (t.tokensOut ?? 0))
        const avgTokens = totalTokens.reduce((a, b) => a + b, 0) / totalTokens.length
        const avgQuality = tasksWithTokensAndQuality.reduce((a, t) => a + (t.qualityScore ?? 0), 0) / tasksWithTokensAndQuality.length

        // High-token tasks (top quartile) with below-average quality
        const tokenThreshold = avgTokens * 1.5
        const highTokenLowQuality = tasksWithTokensAndQuality.filter(t =>
            (t.tokensIn ?? 0) + (t.tokensOut ?? 0) > tokenThreshold && (t.qualityScore ?? 0) < avgQuality
        )

        if (highTokenLowQuality.length >= 3) {
            proposals.push({
                type: 'routing_inefficiency',
                hypothesis: `${highTokenLowQuality.length} tasks consumed high tokens (>${Math.round(tokenThreshold)}) but scored below average quality (${avgQuality.toFixed(1)}). Model routing may be sending complex tasks to underpowered models.`,
                proposedChange: { action: 'review_model_routing', tokenThreshold: Math.round(tokenThreshold), avgQuality: Number(avgQuality.toFixed(2)) },
                risk: 'medium',
            })
        }
    }

    // 6. Correction surge — user corrections exceed threshold
    if (correctionCount >= 3) {
        proposals.push({
            type: 'correction_surge',
            hypothesis: `${correctionCount} user corrections recorded in the last 14 days. The agent may be consistently misinterpreting user intent or producing incorrect output.`,
            proposedChange: { action: 'review_system_prompt_and_behavior_rules', correctionCount },
            risk: 'medium',
        })
    }

    return proposals
}
