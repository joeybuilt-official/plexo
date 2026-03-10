import { db, workLedger, rsiProposals, workspaces } from '@plexo/db'
import { eq, gte, and, sql, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { eventBus, TOPICS } from '../plugins/event-bus.js'
const logger = console

export type AnomalyType = 'quality_degradation' | 'confidence_skew' | 'cost_spikes'

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
    const activeWorkspaces = await db.select({ id: workspaces.id }).from(workspaces)

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

    // aggregate all relevant completed tasks for this workspace
    const recentTasks = await db
        .select()
        .from(workLedger)
        .where(
            and(
                eq(workLedger.workspaceId, workspaceId),
                gte(workLedger.completedAt, fourteenDaysAgo)
            )
        )

    if (recentTasks.length < 5) return 0 // Enforce N=5 statistical minimum limit

    const proposals = detectAnomalies(recentTasks)

    let inserted = 0
    // Persist discovered proposals allowing shadow testing
    for (const proposal of proposals) {
        // Prevent duplicate spamming: Don't insert if exactly identical hypothesis exists and remains 'pending'
        const existing = await db.select().from(rsiProposals).where(
            and(
                eq(rsiProposals.workspaceId, workspaceId),
                eq(rsiProposals.anomalyType, proposal.type),
                eq(rsiProposals.status, 'pending')
            )
        ).limit(1)

        if (existing.length === 0) {
            await db.insert(rsiProposals).values({
                workspaceId,
                anomalyType: proposal.type,
                hypothesis: proposal.hypothesis,
                proposedChange: proposal.proposedChange,
                risk: proposal.risk,
            })
            inserted++
            logger.info({ event: 'rsi_proposal_emitted', workspaceId, type: proposal.type }, 'RSI generated new proposal hypothesis')
            eventBus.publish(TOPICS.RSI_PROPOSAL_CREATED, { workspaceId, type: proposal.type, hypothesis: proposal.hypothesis })
        }
    }

    return inserted
}

export function detectAnomalies(recentTasks: any[]): RSIAnomaly[] {
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

    // 3. Check for 'cost_spikes' against a rolling average mechanism (simplified for scope: hardcoded reference)
    const costAggregations = recentTasks.filter(t => t.costUsd && t.costUsd > 0.0)
    if (costAggregations.length >= 5) {
        // Evaluate historical vs current window. Here we simulate a >2x check context
        const avgCost = costAggregations.reduce((acc, t) => acc + (t.costUsd || 0), 0) / costAggregations.length
        
        // Let's pretend the historical avg is hardcoded derived to $0.50 per task as a baseline
        const historicalAvg = 0.50
        
        if (avgCost > (historicalAvg * 2.0)) {
            proposals.push({
                type: 'cost_spikes',
                hypothesis: `Average task cost spiked to $${avgCost.toFixed(2)}. Clarification loops may be unbounded.`,
                proposedChange: { action: 'cap_clarification_loops', target: 'soul_protocol', threshold: 2 },
                risk: 'high'
            })
        }
    }

    return proposals
}
