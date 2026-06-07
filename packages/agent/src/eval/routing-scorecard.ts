// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing scorecard (Round-5 Phase 3, ADR 0001).
 *
 * Read-only. Joins the routing decision (`tasks.routed_model`, written at
 * dispatch) to the outcome (`tasks.quality_score`, written by the judge) and
 * compares per-model mean quality with the existing Welch t-test from
 * `ab-variants.ts`. This is what turns the Phase-4 D2 model flip from a guess
 * into a measured decision.
 *
 * The pure tasks-join scorecard covers task-bearing extraction. Proxy-only
 * graphiti extraction (no task row) is measured separately via the shadow
 * re-extraction agreement stream (`shadow_extraction_results`), surfaced by
 * `shadowExtractionScorecard()` below.
 */

import { db, sql } from '@plexo/db'
import { welchsTTest } from '../memory/ab-variants.js'
import type { TaskType } from '../providers/registry.js'

export interface ModelArm {
    model: string
    n: number
    meanQuality: number
}

export interface ArmComparison {
    /** Lower-mean arm (baseline). */
    a: string
    /** Higher-mean arm (challenger). */
    b: string
    meanA: number
    meanB: number
    tStat: number
    /** One-tailed p that B > A. <0.05 ⇒ B significantly better. */
    pValue: number
    /** Both arms cleared the minimum sample bar. */
    sufficient: boolean
}

export interface RoutingScorecard {
    taskType: TaskType
    minSamples: number
    arms: ModelArm[]
    comparisons: ArmComparison[]
}

/**
 * Per-model quality scorecard for a task type, with pairwise Welch tests.
 *
 * @param taskType  which `tasks.type` to score (default 'extraction' — the D2 target).
 * @param minSamples per-arm sample floor for a comparison to be flagged sufficient (default 100, ADR 0001 §3).
 */
export async function routingScorecard(opts: {
    taskType?: TaskType
    minSamples?: number
} = {}): Promise<RoutingScorecard> {
    const taskType = opts.taskType ?? 'extraction'
    const minSamples = opts.minSamples ?? 100

    const rows = (await db.execute(sql`
        SELECT routed_model AS model, quality_score AS quality
        FROM tasks
        WHERE type = ${taskType}
          AND routed_model IS NOT NULL
          AND quality_score IS NOT NULL
    `)) as unknown as Array<{ model: string; quality: number }>

    const byModel = new Map<string, number[]>()
    for (const r of rows) {
        const q = Number(r.quality)
        if (!Number.isFinite(q)) continue
        const arr = byModel.get(r.model) ?? []
        arr.push(q)
        byModel.set(r.model, arr)
    }

    const arms: ModelArm[] = [...byModel.entries()]
        .map(([model, scores]) => ({
            model,
            n: scores.length,
            meanQuality: scores.reduce((s, v) => s + v, 0) / scores.length,
        }))
        .sort((x, y) => y.meanQuality - x.meanQuality)

    // Pairwise comparisons across all arms with ≥2 samples (Welch needs n-1>0).
    const comparable = [...byModel.entries()].filter(([, s]) => s.length >= 2)
    const comparisons: ArmComparison[] = []
    for (let i = 0; i < comparable.length; i++) {
        for (let j = i + 1; j < comparable.length; j++) {
            const [mA, sA] = comparable[i]!
            const [mB, sB] = comparable[j]!
            const meanA = sA.reduce((s, v) => s + v, 0) / sA.length
            const meanB = sB.reduce((s, v) => s + v, 0) / sB.length
            // Orient so b = higher mean (the Welch test is one-tailed B>A).
            const [loModel, loScores, hiModel, hiScores] = meanA <= meanB
                ? [mA, sA, mB, sB]
                : [mB, sB, mA, sA]
            const t = welchsTTest(loScores, hiScores)
            comparisons.push({
                a: loModel,
                b: hiModel,
                meanA: t.meanA,
                meanB: t.meanB,
                tStat: t.tStat,
                pValue: t.pValue,
                sufficient: loScores.length >= minSamples && hiScores.length >= minSamples,
            })
        }
    }

    return { taskType, minSamples, arms, comparisons }
}

export interface ModelRouterTaskScore {
    taskType: string
    /** Shadow window: how often the model-router's would-pick differed from the served model. */
    shadow: { n: number; divergent: number; divergenceRate: number }
    /**
     * Post-flip A/B: served-model quality split by whether the model-level router
     * chose it. Populated only once the serving flip (PLEXO_MODEL_ROUTER) is on;
     * before that the router arm is empty.
     */
    ab: {
        baseline: { n: number; meanQuality: number }
        router: { n: number; meanQuality: number }
        /** One-tailed Welch p that router quality > baseline; null until both arms have ≥2. */
        pValue: number | null
        /** Both arms cleared minSamples. */
        sufficient: boolean
    }
}

/**
 * Model-level router scorecard (Round-6 Phase 4). Read-only. Per task type:
 *  - shadow divergence over the window (would-pick vs served) — measurable while
 *    the serving flip is OFF, from `routing_events.shadow_model_choice`.
 *  - post-flip quality A/B — served quality (`tasks.quality_score`) split by
 *    `routing_events.model_routed`, with a one-tailed Welch test.
 * This is the evidence that gates the Phase 5 flip.
 */
export async function modelRouterScorecard(opts: {
    windowDays?: number
    minSamples?: number
} = {}): Promise<ModelRouterTaskScore[]> {
    const windowDays = opts.windowDays ?? 14
    const minSamples = opts.minSamples ?? 100

    const divRows = (await db.execute(sql`
        SELECT task_type,
               COUNT(*) FILTER (WHERE shadow_model_choice IS NOT NULL) AS shadow_n,
               COUNT(*) FILTER (
                   WHERE shadow_model_choice IS NOT NULL
                     AND (provider || '/' || model) IS DISTINCT FROM (shadow_model_choice::jsonb ->> 'chosen')
               ) AS divergent_n
        FROM routing_events
        WHERE created_at > NOW() - INTERVAL '1 day' * ${windowDays}
        GROUP BY task_type
    `)) as unknown as Array<{ task_type: string; shadow_n: number; divergent_n: number }>

    const qRows = (await db.execute(sql`
        SELECT re.task_type AS task_type, re.model_routed AS model_routed, t.quality_score AS quality
        FROM routing_events re
        JOIN tasks t ON t.id = re.task_id
        WHERE re.created_at > NOW() - INTERVAL '1 day' * ${windowDays}
          AND re.task_id IS NOT NULL
          AND t.quality_score IS NOT NULL
    `)) as unknown as Array<{ task_type: string; model_routed: boolean; quality: number }>

    const byTask = new Map<string, { baseline: number[]; router: number[] }>()
    for (const r of qRows) {
        const q = Number(r.quality)
        if (!Number.isFinite(q)) continue
        const e = byTask.get(r.task_type) ?? { baseline: [], router: [] }
        ;(r.model_routed ? e.router : e.baseline).push(q)
        byTask.set(r.task_type, e)
    }

    const divByTask = new Map<string, { shadow_n: number; divergent_n: number }>()
    for (const d of divRows) divByTask.set(d.task_type, { shadow_n: Number(d.shadow_n), divergent_n: Number(d.divergent_n) })

    const taskTypes = new Set<string>([...byTask.keys(), ...divByTask.keys()])
    const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)

    return [...taskTypes].map(taskType => {
        const d = divByTask.get(taskType) ?? { shadow_n: 0, divergent_n: 0 }
        const q = byTask.get(taskType) ?? { baseline: [], router: [] }
        const canTest = q.baseline.length >= 2 && q.router.length >= 2
        return {
            taskType,
            shadow: {
                n: d.shadow_n,
                divergent: d.divergent_n,
                divergenceRate: d.shadow_n > 0 ? d.divergent_n / d.shadow_n : 0,
            },
            ab: {
                baseline: { n: q.baseline.length, meanQuality: mean(q.baseline) },
                router: { n: q.router.length, meanQuality: mean(q.router) },
                pValue: canTest ? welchsTTest(q.baseline, q.router).pValue : null,
                sufficient: q.baseline.length >= minSamples && q.router.length >= minSamples,
            },
        }
    }).sort((a, b) => b.shadow.n - a.shadow.n)
}

export interface ShadowPair {
    primaryModel: string
    shadowModel: string
    n: number
    meanAgreement: number
    /** Mean (shadow − primary) extracted-field count. Negative ⇒ shadow extracts less. */
    meanFieldDelta: number
}

/**
 * Graphiti shadow re-extraction agreement, grouped by (primary, shadow) model
 * pair. Low agreement or a strongly negative field delta is the regression
 * signal that gates the Phase-4 D2 flip for the proxy-only (task-less) path.
 */
export async function shadowExtractionScorecard(): Promise<ShadowPair[]> {
    const rows = (await db.execute(sql`
        SELECT primary_model,
               shadow_model,
               COUNT(*)::int                                            AS n,
               AVG(agreement_score)                                     AS mean_agreement,
               AVG(COALESCE(shadow_field_count, 0)
                   - COALESCE(primary_field_count, 0))                  AS mean_field_delta
        FROM shadow_extraction_results
        GROUP BY primary_model, shadow_model
        ORDER BY n DESC
    `)) as unknown as Array<{
        primary_model: string
        shadow_model: string
        n: number
        mean_agreement: number
        mean_field_delta: number
    }>

    return rows.map((r) => ({
        primaryModel: r.primary_model,
        shadowModel: r.shadow_model,
        n: Number(r.n),
        meanAgreement: Number(r.mean_agreement),
        meanFieldDelta: Number(r.mean_field_delta),
    }))
}
