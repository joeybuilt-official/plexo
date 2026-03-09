// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Prompt A/B variant system
 *
 * Assigns tasks to a prompt "variant" (control vs. challenger) and
 * tracks quality scores per variant to auto-promote winners.
 *
 * Assignment:
 *   - Control (A): current approved prompt_overrides from workspace_preferences
 *   - Challenger (B): pending improvement proposal not yet applied
 *   - 80/20 split — 80% control, 20% challenger
 *   - If no pending challenger, all tasks go to control
 *
 * Promotion criteria (evaluated after every task):
 *   - Variant B must have ≥ 20 samples
 *   - Median quality(B) > median quality(A) + 0.05
 *   - If met: auto-apply the challenger patch without operator review
 *   - If B has ≥ 30 samples and is NOT winning: discard challenger, propose fresh analysis
 *
 * This loop runs entirely within the executor at task completion — no separate job needed.
 */
import { db, sql, desc, eq } from '@plexo/db'
import { workLedger } from '@plexo/db'
import { getPreference, learnPreference } from './preferences.js'
import pino from 'pino'

const logger = pino({ name: 'ab-variants' })

/** Variant assignment result */
export interface VariantAssignment {
    /** 'A' = control, 'B' = challenger */
    variant: 'A' | 'B'
    /** ID of the improvement_log entry being tested (null for control) */
    challengerId: string | null
    /** The prompt overrides to inject into this task's system prompt */
    overrides: Record<string, string>
}

/** Assign a variant for this task invocation */
export async function assignVariant(workspaceId: string): Promise<VariantAssignment> {
    const control = ((await getPreference(workspaceId, 'prompt_overrides')) as Record<string, string> | null) ?? {}

    // Find the active pending challenger (most recent unapplied prompt_patch proposal)
    const challengers = await db.execute<{
        id: string
        proposed_change: string
        metadata: unknown
    }>(sql`
        SELECT id, proposed_change, metadata FROM agent_improvement_log
        WHERE workspace_id = ${workspaceId}::uuid
          AND pattern_type = 'prompt_patch'
          AND applied = false
          AND (metadata->>'discarded')::boolean IS NOT TRUE
        ORDER BY created_at DESC
        LIMIT 1
    `)

    const challenger = challengers[0]

    if (!challenger) {
        return { variant: 'A', challengerId: null, overrides: control }
    }

    // Multi-Armed Bandit (UCB) assignment
    const meta = challenger.metadata as { variants?: { v: string; q: number }[] } | null
    const variants = meta?.variants ?? []

    const aScores = variants.filter((v) => v.v === 'A').map((v) => v.q)
    const bScores = variants.filter((v) => v.v === 'B').map((v) => v.q)
    const totalSamples = aScores.length + bScores.length

    let useChallenger = false
    if (aScores.length === 0 || bScores.length === 0) {
        // Force exploration of both initially
        useChallenger = bScores.length <= aScores.length
    } else {
        const meanA = aScores.reduce((a, b) => a + b, 0) / aScores.length
        const meanB = bScores.reduce((a, b) => a + b, 0) / bScores.length
        const c = 0.3 // exploration coefficient
        const ucbA = meanA + c * Math.sqrt(Math.log(totalSamples) / aScores.length)
        const ucbB = meanB + c * Math.sqrt(Math.log(totalSamples) / bScores.length)
        useChallenger = ucbB > ucbA
    }

    if (!useChallenger) {
        return { variant: 'A', challengerId: challenger.id, overrides: control }
    }

    let challengerOverrides: Record<string, string> = { ...control }
    try {
        const patch = JSON.parse(challenger.proposed_change) as { section: string; proposed: string }
        challengerOverrides = { ...control, [patch.section]: patch.proposed }
    } catch {
        // malformed patch — fall back to control
        return { variant: 'A', challengerId: challenger.id, overrides: control }
    }

    return { variant: 'B', challengerId: challenger.id, overrides: challengerOverrides }
}

/**
 * Record which variant was used for a task and its quality score,
 * then evaluate promotion / discard criteria.
 */
export async function recordVariantOutcome(params: {
    workspaceId: string
    taskId: string
    variant: 'A' | 'B'
    challengerId: string | null
    qualityScore: number
}): Promise<void> {
    const { workspaceId, challengerId, variant, qualityScore } = params

    // Persist variant assignment on the improvement log entry so we can aggregate
    if (challengerId) {
        await db.execute(sql`
            UPDATE agent_improvement_log
            SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                    'variants', COALESCE(metadata->'variants', '[]'::jsonb) ||
                        jsonb_build_array(jsonb_build_object('v', ${variant}, 'q', ${qualityScore}))
                )
            WHERE id = ${challengerId}::uuid
        `)
    }

    // Re-read stats and evaluate
    if (!challengerId) return
    await evaluateVariant(workspaceId, challengerId)
}

async function evaluateVariant(workspaceId: string, challengerId: string): Promise<void> {
    const rows = await db.execute<{ metadata: unknown }>(sql`
        SELECT metadata FROM agent_improvement_log
        WHERE id = ${challengerId}::uuid
        LIMIT 1
    `)

    const meta = rows[0]?.metadata as { variants?: { v: string; q: number }[]; discarded?: boolean } | null
    const variants = meta?.variants ?? []

    const aScores = variants.filter((v) => v.v === 'A').map((v) => v.q)
    const bScores = variants.filter((v) => v.v === 'B').map((v) => v.q)

    // Require a minimum baseline of evidence
    if (bScores.length < 20 || aScores.length < 5) return

    const stats = welchsTTest(aScores, bScores)

    logger.info({
        challengerId,
        meanA: stats.meanA,
        meanB: stats.meanB,
        pValue: stats.pValue,
        bSamples: bScores.length
    }, 'A/B statistical evaluation (Welch t-test)')

    // 95% confidence interval for B being significantly better than A
    if (stats.meanB > stats.meanA && stats.pValue < 0.05) {
        logger.info({ challengerId, pValue: stats.pValue, meanA: stats.meanA, meanB: stats.meanB }, 'Challenger prompt wins — auto-promoting')
        await autoPromote(workspaceId, challengerId)
        return
    }

    // Discard if we've gathered enough evidence and it's still not winning
    if (bScores.length >= 40) {
        logger.info({ challengerId, pValue: stats.pValue }, 'Challenger prompt lost after 40 samples — discarding')
        await db.execute(sql`
            UPDATE agent_improvement_log
            SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"discarded": true}'::jsonb
            WHERE id = ${challengerId}::uuid
        `)
    }
}

async function autoPromote(workspaceId: string, challengerId: string): Promise<void> {
    const rows = await db.execute<{ proposed_change: string }>(sql`
        SELECT proposed_change FROM agent_improvement_log
        WHERE id = ${challengerId}::uuid
        LIMIT 1
    `)

    const row = rows[0]
    if (!row) return

    try {
        const patch = JSON.parse(row.proposed_change) as { section: string; proposed: string }
        const current = ((await getPreference(workspaceId, 'prompt_overrides')) as Record<string, string> | null) ?? {}
        const updated = { ...current, [patch.section]: patch.proposed }

        await learnPreference({
            workspaceId,
            key: 'prompt_overrides',
            value: updated,
            observationConfidence: 0.95, // higher than manual — statistically validated
        })

        await db.execute(sql`
            UPDATE agent_improvement_log
            SET applied = true,
                metadata = COALESCE(metadata, '{}'::jsonb) || '{"auto_promoted": true}'::jsonb
            WHERE id = ${challengerId}::uuid
        `)

        logger.info({ workspaceId, challengerId, section: patch.section }, 'Prompt A/B challenger auto-promoted')
    } catch (err) {
        logger.error({ err, challengerId }, 'Auto-promotion failed')
    }
}

function welchsTTest(a: number[], b: number[]): { pValue: number, tStat: number, meanA: number, meanB: number } {
    const meanA = a.reduce((sum, val) => sum + val, 0) / a.length
    const meanB = b.reduce((sum, val) => sum + val, 0) / b.length

    // Sample variances
    const varA = a.reduce((sum, val) => sum + Math.pow(val - meanA, 2), 0) / (a.length - 1)
    const varB = b.reduce((sum, val) => sum + Math.pow(val - meanB, 2), 0) / (b.length - 1)

    if (varA === 0 && varB === 0) {
        return { pValue: meanA < meanB ? 0 : 1, tStat: 0, meanA, meanB }
    }

    const seA = varA / a.length
    const seB = varB / b.length
    const tStat = (meanB - meanA) / Math.sqrt(seA + seB)

    // Normal approximation for p-value (sufficient for N >= 20)
    // One-tailed test (is B strictly > A?)
    const pValue = 1 - normalCdf(tStat)
    return { pValue, tStat, meanA, meanB }
}

function normalCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const d = 0.3989423 * Math.exp(-x * x / 2)
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
    return x > 0 ? 1 - p : p
}
