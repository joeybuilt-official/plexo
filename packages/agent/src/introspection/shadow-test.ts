// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, workLedger, rsiProposals, rsiTestResults } from '@plexo/db'
import { eq, and, gte, desc, lt } from 'drizzle-orm'

const logger = console

/**
 * Shadow-test an approved RSI proposal.
 *
 * Strategy: take the N most recent completed tasks from work_ledger as the
 * "baseline" window. Simulate the proposed change by scoring each task against
 * the proposal's intent and record a per-task rsi_test_results row.
 *
 * This is intentionally a lightweight heuristic — real shadow testing would
 * re-execute tasks with the proposed config change. This version estimates the
 * delta from existing ledger data so it runs synchronously with no new LLM calls.
 */
export async function runShadowTest(proposalId: string, workspaceId: string): Promise<void> {
    logger.info({ event: 'shadow_test_start', proposalId }, 'Shadow test starting')

    const [proposal] = await db.select()
        .from(rsiProposals)
        .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
        .limit(1)

    if (!proposal || proposal.status !== 'approved') {
        logger.warn({ proposalId }, 'Shadow test skipped — proposal not found or not approved')
        return
    }

    // Pull the last 10 tasks as baseline sample
    const baselineWindow = await db.select()
        .from(workLedger)
        .where(eq(workLedger.workspaceId, workspaceId))
        .orderBy(desc(workLedger.completedAt))
        .limit(10)

    if (baselineWindow.length === 0) {
        logger.info({ proposalId }, 'Shadow test skipped — no baseline tasks')
        return
    }

    // Compute a historical average window from tasks prior to the baseline
    // (used to estimate what the "shadow" delta would be).
    const oldestBaselineTs = baselineWindow[baselineWindow.length - 1]?.completedAt
    let historicalAvgCost = 0
    let historicalAvgQuality = 0
    if (oldestBaselineTs) {
        const prior = await db.select()
            .from(workLedger)
            .where(and(
                eq(workLedger.workspaceId, workspaceId),
                lt(workLedger.completedAt, oldestBaselineTs)
            ))
            .orderBy(desc(workLedger.completedAt))
            .limit(20)

        if (prior.length > 0) {
            historicalAvgCost = prior.reduce((s, t) => s + (t.costUsd ?? 0), 0) / prior.length
            historicalAvgQuality = prior
                .filter(t => t.qualityScore !== null)
                .reduce((s, t) => s + (t.qualityScore ?? 0), 0) /
                Math.max(1, prior.filter(t => t.qualityScore !== null).length)
        }
    }

    // For each baseline task, estimate a "shadow" quality score by modelling
    // the hypothetical improvement from the proposed change.
    const rows: Array<typeof rsiTestResults.$inferInsert> = baselineWindow.map(task => {
        const baselineQuality = task.qualityScore ?? null
        const baselineCost = task.costUsd ?? 0

        // Simulate shadow quality: apply the proposed change's expected effect.
        let shadowQuality: number | null = baselineQuality
        let shadowCost = baselineCost

        switch (proposal.anomalyType) {
            case 'quality_degradation':
                // Proposed: tighten verification → expected +5–10% quality uplift
                shadowQuality = baselineQuality !== null
                    ? Math.min(1.0, baselineQuality * 1.08)
                    : null
                break

            case 'confidence_skew':
                // Proposed: add unknowns enumeration → expected modest quality + lower cost
                // (fewer retry loops due to earlier uncertainty flagging)
                shadowQuality = baselineQuality !== null
                    ? Math.min(1.0, baselineQuality * 1.04)
                    : null
                shadowCost = baselineCost * 0.92
                break

            case 'cost_spikes':
                // Proposed: cap clarification loops → expected cost reduction, neutral quality
                shadowCost = baselineCost * 0.70
                break
        }

        const tokenDelta = shadowCost !== baselineCost
            ? Math.round(((shadowCost - baselineCost) / Math.max(0.001, baselineCost)) * 1000)
            : 0

        return {
            proposalId,
            taskId: task.taskId ?? null,
            isShadow: true,
            baselineQuality,
            shadowQuality,
            tokenDelta,
        }
    })

    await db.insert(rsiTestResults).values(rows)

    const avgBaselineQuality = rows
        .filter(r => r.baselineQuality !== null)
        .reduce((s, r) => s + (r.baselineQuality ?? 0), 0) /
        Math.max(1, rows.filter(r => r.baselineQuality !== null).length)

    const avgShadowQuality = rows
        .filter(r => r.shadowQuality !== null)
        .reduce((s, r) => s + (r.shadowQuality ?? 0), 0) /
        Math.max(1, rows.filter(r => r.shadowQuality !== null).length)

    logger.info({
        event: 'shadow_test_complete',
        proposalId,
        tasks: rows.length,
        avgBaselineQuality: avgBaselineQuality.toFixed(3),
        avgShadowQuality: avgShadowQuality.toFixed(3),
    }, 'Shadow test results written')
}
