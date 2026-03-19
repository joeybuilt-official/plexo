import { db, workLedger, rsiProposals, workspaces } from '@plexo/db'
import { eq, gte, and, desc } from 'drizzle-orm'
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
        })
        .from(workLedger)
        .where(
            and(
                eq(workLedger.workspaceId, workspaceId),
                gte(workLedger.completedAt, fourteenDaysAgo)
            )
        )
        .limit(1000)

    if (recentTasks.length < 5) return 0 // Enforce N=5 statistical minimum limit

    const proposals = detectAnomalies(recentTasks)

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
}

export function detectAnomalies(recentTasks: TaskRecord[]): RSIAnomaly[] {
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

    return proposals
}
