// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — model-level router shadow path (Round-6 Phase 1).
 *
 * Computes what the model-level router WOULD pick for a routing decision,
 * without changing the model actually served. Gated behind `PLEXO_MODEL_ROUTER`
 * (default OFF). The result is persisted to `routing_events.shadow_model_choice`
 * by the telemetry sink so served-vs-shadow can be A/B-compared later (Phase 4)
 * before any flip (Phase 5).
 *
 * Phase 1 is gate-only: there is no weighted scorer yet (Phase 2). The
 * provisional pick is the highest manifest task-prior among gated candidates,
 * tie-broken by reliability then cost (quality-first objective, decision #1).
 * This previews model-level selection; Phase 2 replaces `provisionalPick` with
 * the real scorer. ADR 0006, Round-6 plan Phase 1.
 */

import { db, inArray, modelsKnowledge } from '@plexo/db'
import { enumerateModelCandidates, capabilityGate, type KnowledgeRow } from './enumerate.js'
import type { ModelCandidate } from './candidate.js'
import type { Capability } from './manifest.js'
import type { AvailableProvider } from './selector.js'
import type { TaskType, WorkspaceAISettings } from '../registry.js'

/**
 * Serving flip (default OFF). When ON, the model-level router's pick is actually
 * served (Phase 2+ selector integration). Stays OFF in prod until Phase 5.
 */
export function isModelRouterEnabled(): boolean {
    return process.env.PLEXO_MODEL_ROUTER === '1'
}

/**
 * Observe-only shadow logging (default OFF). Distinct from the serving flip so
 * shadow would-pick data can accrue in prod (Phases 1–4) with the served model
 * UNCHANGED. The serving flip implies shadow too, so once flipped (Phase 5)
 * served-vs-shadow comparison keeps logging.
 */
export function isShadowLoggingEnabled(): boolean {
    return process.env.PLEXO_MODEL_ROUTER_SHADOW === '1' || isModelRouterEnabled()
}

export interface ShadowChoice {
    /** `provider/model` the model-level router would pick. */
    chosen: string
    /** Manifest task-prior of the pick (0 when unmanifested). */
    prior: number
    /** Top of the gated shortlist as `provider/model`, ranked, capped. */
    shortlist: string[]
    reason: string
}

/**
 * Provisional Phase-1 pick: highest task-prior, tie-broken by reliability desc
 * then input cost asc (quality-first w/ cost tiebreaker). NOT the Phase-2 scorer.
 */
export function provisionalPick(taskType: TaskType, candidates: readonly ModelCandidate[]): ModelCandidate | null {
    if (candidates.length === 0) return null
    const prior = (c: ModelCandidate) => c.priorScoreByTask[taskType] ?? 0
    return [...candidates].sort((a, b) => {
        if (prior(b) !== prior(a)) return prior(b) - prior(a)
        if (b.reliability !== a.reliability) return b.reliability - a.reliability
        if (a.costPerMIn !== b.costPerMIn) return a.costPerMIn - b.costPerMIn
        return `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`)
    })[0]!
}

export interface ShadowInput {
    taskType: TaskType
    /** The connected provider pool for this decision (first-selection pool). */
    available: AvailableProvider[]
    settings: WorkspaceAISettings
    /** Per-task hard capability requirements (Phase 3 fills these; [] for now). */
    requirements?: readonly Capability[]
}

async function fetchKnowledge(providers: readonly string[]): Promise<KnowledgeRow[]> {
    if (providers.length === 0) return []
    const rows = await db
        .select({
            provider: modelsKnowledge.provider,
            modelId: modelsKnowledge.modelId,
            contextWindow: modelsKnowledge.contextWindow,
            costPerMIn: modelsKnowledge.costPerMIn,
            costPerMOut: modelsKnowledge.costPerMOut,
            strengths: modelsKnowledge.strengths,
            reliabilityScore: modelsKnowledge.reliabilityScore,
        })
        .from(modelsKnowledge)
        .where(inArray(modelsKnowledge.provider, [...providers]))
    return rows.map(r => ({
        provider: r.provider,
        modelId: r.modelId,
        contextWindow: r.contextWindow ?? undefined,
        costPerMIn: r.costPerMIn ?? undefined,
        costPerMOut: r.costPerMOut ?? undefined,
        strengths: Array.isArray(r.strengths) ? r.strengths : undefined,
        reliabilityScore: r.reliabilityScore ?? undefined,
    }))
}

/**
 * Compute the shadow choice for a decision. Returns null when disabled, on no
 * candidates, or on any error (telemetry must never break routing). Fetches
 * knowledge rows for the connected providers; discovered models are omitted in
 * Phase 1 (the configured/resolved model is always a candidate).
 */
export async function computeShadowChoice(input: ShadowInput): Promise<ShadowChoice | null> {
    if (!isShadowLoggingEnabled()) return null
    try {
        const providers = Array.from(new Set(input.available.map(a => a.provider as string)))
        const knowledge = await fetchKnowledge(providers)
        const candidates = enumerateModelCandidates({
            taskType: input.taskType,
            availableProviders: input.available,
            settings: input.settings,
            knowledge,
        })
        const gated = capabilityGate(input.requirements ?? [], candidates)
        const pick = provisionalPick(input.taskType, gated)
        if (!pick) return null
        const rank = (a: ModelCandidate, b: ModelCandidate) =>
            (b.priorScoreByTask[input.taskType] ?? 0) - (a.priorScoreByTask[input.taskType] ?? 0)
        return {
            chosen: `${pick.provider}/${pick.modelId}`,
            prior: pick.priorScoreByTask[input.taskType] ?? 0,
            shortlist: [...gated].sort(rank).slice(0, 5).map(c => `${c.provider}/${c.modelId}`),
            reason: `provisional (prior=${pick.priorScoreByTask[input.taskType] ?? 0}, gated=${gated.length}/${candidates.length})`,
        }
    } catch {
        return null
    }
}
