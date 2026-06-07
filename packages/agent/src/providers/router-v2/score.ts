// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 2 — weighted model scorer + selector.
 *
 * Pure + db-free. Scores `ModelCandidate`s for a task using the manifest
 * task-prior, live `router_v2_stats` (success/p95/recent-failure, injected via
 * `statsFor`), per-model reliability, and cost. The quality score mirrors the
 * legacy provider scorer (selector.ts `scoreCandidate`) so flag-on behavior is a
 * model-granular extension of the same shape, plus a small reliability nudge.
 *
 * Objective (operator decision #1): quality-first with a cost tiebreaker
 * (default); cost-first available via PLEXO_ROUTING_OBJECTIVE. Unknown cost
 * (0 — no knowledge row) sorts LAST in any cost comparison, never "cheapest".
 *
 * ADR 0006, Round-6 plan Phase 2.
 */

import type { ModelCandidate } from './candidate.js'
import type { ReadStats } from './stats.js'
import type { ProviderKey, TaskType } from '../registry.js'

export type RoutingObjective = 'quality-first' | 'cost-first'

/** Objective from env; defaults to the operator's quality-first decision. */
export function getRoutingObjective(): RoutingObjective {
    return process.env.PLEXO_ROUTING_OBJECTIVE === 'cost-first' ? 'cost-first' : 'quality-first'
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * Quality score. priorScore (1-5) × success-rate multiplier [0.5,1] × small
 * reliability factor [0.9,1], minus latency + recent-failure penalties. Matches
 * selector.ts scoreCandidate, extended per-model.
 */
export function modelQualityScore(prior: number, s: ReadStats, reliability: number): number {
    const successMultiplier = 0.5 + 0.5 * clamp01(s.successRate)
    const latencyPenalty = Math.min(1, Math.max(0, (s.latencyP95Ms - 1000) / 9000))
    const reliabilityFactor = 0.9 + 0.1 * clamp01(reliability)
    return prior * successMultiplier * reliabilityFactor - latencyPenalty * 0.3 - s.recentFailurePenalty * 0.2
}

export interface ScoredModel {
    candidate: ModelCandidate
    quality: number
    /** costPerMIn, or +Infinity when unknown (no knowledge row). */
    cost: number
    cooling: boolean
    cooldownEndAt: number
    stats: ReadStats
}

export interface ScoreInput {
    candidates: readonly ModelCandidate[]
    taskType: TaskType
    /** Live per-model stats lookup (selector injects getStats). */
    statsFor: (provider: ProviderKey, model: string) => ReadStats
    now: number
    objective?: RoutingObjective
}

/** Unknown cost (0) → +Infinity so it never wins a cost comparison. */
const costKey = (costPerMIn: number) => (costPerMIn > 0 ? costPerMIn : Number.POSITIVE_INFINITY)

export function scoreModelCandidates(input: ScoreInput): ScoredModel[] {
    const { candidates, taskType, statsFor, now } = input
    return candidates.map(c => {
        const prior = c.priorScoreByTask[taskType] ?? 0
        const stats = statsFor(c.provider, c.modelId)
        return {
            candidate: c,
            quality: modelQualityScore(prior, stats, c.reliability),
            cost: costKey(c.costPerMIn),
            cooling: stats.cooldownEndAt > now,
            cooldownEndAt: stats.cooldownEndAt,
            stats,
        }
    })
}

const tiebreak = (a: ScoredModel, b: ScoredModel) =>
    `${a.candidate.provider}/${a.candidate.modelId}`.localeCompare(`${b.candidate.provider}/${b.candidate.modelId}`)

/**
 * Rank candidates best-first per the objective. Non-cooling candidates are
 * preferred; only when ALL are cooling does the cooling pool rank (single-
 * provider rule — a workspace must still get a pick). Returns [] for no input.
 */
export function selectBestModel(input: ScoreInput): ScoredModel[] {
    const objective = input.objective ?? getRoutingObjective()
    const scored = scoreModelCandidates(input)
    if (scored.length === 0) return []
    const nonCooling = scored.filter(s => !s.cooling)
    const pool = nonCooling.length > 0 ? nonCooling : scored
    const cmp =
        objective === 'cost-first'
            ? (a: ScoredModel, b: ScoredModel) => a.cost - b.cost || b.quality - a.quality || tiebreak(a, b)
            : (a: ScoredModel, b: ScoredModel) => b.quality - a.quality || a.cost - b.cost || tiebreak(a, b)
    return [...pool].sort(cmp)
}
