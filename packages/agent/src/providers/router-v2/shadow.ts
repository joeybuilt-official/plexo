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
import { selectBestModel } from './score.js'
import { getStats } from './stats.js'
import { isModelRouterEnabled, isShadowLoggingEnabled } from './flags.js'
import type { ModelCandidate } from './candidate.js'
import type { Capability } from './manifest.js'
import type { AvailableProvider } from './selector.js'
import type { TaskType, WorkspaceAISettings } from '../registry.js'

export { isModelRouterEnabled, isShadowLoggingEnabled }

export interface ShadowChoice {
    /** `provider/model` the model-level router would pick. */
    chosen: string
    /** Manifest task-prior of the pick (0 when unmanifested). */
    prior: number
    /** Top of the gated shortlist as `provider/model`, ranked, capped. */
    shortlist: string[]
    reason: string
}

export interface ShadowInput {
    workspaceId: string | undefined
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
 * Fetch knowledge + enumerate + capability-gate the model candidates for a
 * decision. Shared by the shadow path and the serving integration (index.ts).
 * Discovered models are omitted (the configured/resolved model is always a
 * candidate; single-provider rule). Returns the gated candidate list.
 */
export async function loadModelCandidates(input: ShadowInput): Promise<ModelCandidate[]> {
    const providers = Array.from(new Set(input.available.map(a => a.provider as string)))
    const knowledge = await fetchKnowledge(providers)
    const candidates = enumerateModelCandidates({
        taskType: input.taskType,
        availableProviders: input.available,
        settings: input.settings,
        knowledge,
    })
    return capabilityGate(input.requirements ?? [], candidates)
}

/**
 * Compute the shadow choice for a decision. Returns null when disabled, on no
 * candidates, or on any error (telemetry must never break routing). Uses the
 * Phase-2 weighted scorer (`selectBestModel`) so the shadow would-pick matches
 * what serving would pick once flipped.
 */
export async function computeShadowChoice(input: ShadowInput): Promise<ShadowChoice | null> {
    if (!isShadowLoggingEnabled()) return null
    try {
        const gated = await loadModelCandidates(input)
        const ranked = selectBestModel({
            candidates: gated,
            taskType: input.taskType,
            statsFor: (provider, model) => getStats({ workspaceId: input.workspaceId, provider, model, taskType: input.taskType }),
            now: Date.now(),
        })
        if (ranked.length === 0) return null
        const top = ranked[0]!
        const prior = top.candidate.priorScoreByTask[input.taskType] ?? 0
        return {
            chosen: `${top.candidate.provider}/${top.candidate.modelId}`,
            prior,
            shortlist: ranked.slice(0, 5).map(s => `${s.candidate.provider}/${s.candidate.modelId}`),
            reason: `scored (q=${top.quality.toFixed(2)}, prior=${prior}, gated=${gated.length})`,
        }
    } catch {
        return null
    }
}
