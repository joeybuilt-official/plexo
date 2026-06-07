// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — pure selector.
 *
 * `selectModel({ workspaceId, taskType, availableProviders, settings }) → SelectionResult`
 *
 * Algorithm:
 *   1. Build candidate list from `availableProviders` × resolved model.
 *   2. Look up manifest entry per candidate; skip if `hardSkipPredicate` true.
 *   3. Low manifest quality is NEVER a hard block (single-provider rule): a
 *      workspace must work with whatever provider it has. A high-stakes task on
 *      below-bar providers degrades-and-proceeds with `degradationReason`, not
 *      `requireOperatorAction`. (Was a Q2-hybrid block — removed 2026-06-07.)
  *   4. Score = priorScore × 1.0 − latencyP95Penalty × 0.3 − recentFailurePenalty × 0.2.
 *   5. chosen = top scorer; alternatives = next 2 with reason.
 *
 * Must return within 50ms p95 (first principle #1).
 */

import {
    PROVIDER_DEFAULT_MODEL_CLASS,
    getManifestEntry,
    manifestVersion,
    type ManifestEntry,
} from './manifest.js'
import { getStats } from './stats.js'
import { RECOMMENDED_PRIOR } from './quality-warnings.js'
import {
    DEFAULT_MODEL_ROUTING,
    PROVIDER_DEFAULT_MODELS,
    type AIProviderConfig,
    type ProviderKey,
    type TaskType,
    type WorkspaceAISettings,
} from '../registry.js'

export interface AvailableProvider {
    provider: ProviderKey
    config: AIProviderConfig
}

export interface Alternative {
    provider: ProviderKey
    model: string
    score: number
    priorScore: number
    whyNotPicked: string
}

export interface ChosenModel {
    provider: ProviderKey
    model: string
    score: number
    priorScore: number
    manifestEntry: ManifestEntry
}

export interface SelectionResult {
    /** Null when Q2 hybrid blocks (high-stakes task + only low-quality candidates). */
    chosen: ChosenModel | null
    alternatives: Alternative[]
    rationale: string
    manifestVersion: typeof manifestVersion
    /** True when no candidate met the high-stakes quality bar; UI must prompt operator. */
    requireOperatorAction: boolean
    /** True when no candidate was scoreable (e.g. all providers were unmanifested). */
    noManifestMatch: boolean
    /**
     * Set when the chosen candidate's priorScore is below RECOMMENDED_PRIOR.
     * Settings page reads the 7-day count to render the `provider_quality_warning` chip.
     */
    degradationReason?: 'workspace_low_quality_only'
    /** Round-4 D2: true when `chosen` came from a forced modelIdOverride (bypassed scoring). */
    forcedModel?: boolean
}

export interface SelectInput {
    workspaceId: string | undefined
    taskType: TaskType
    /** Providers the workspace has configured + we should consider. Order is honored as a soft prior. */
    availableProviders: AvailableProvider[]
    settings: WorkspaceAISettings
    /**
     * Round-4 D2: per-call forced model. Accepts `provider/model` or a bare
     * `model` id. When it resolves to a configured provider (with a manifest
     * entry for this task type) the selector force-picks it, bypassing scoring.
     * If it can't be resolved (provider absent / in the excluded pool), the
     * selector falls through to normal scoring. Default unset = no override.
     */
    modelIdOverride?: string
}

/** Resolve the concrete model ID this candidate would call. */
export function resolveModelId(
    provider: ProviderKey,
    config: AIProviderConfig,
    taskType: TaskType,
    settings: WorkspaceAISettings,
): string {
    const validModel = (id: string | undefined) =>
        id && id.trim() !== '' && id !== 'default' && id !== 'placeholder' ? id : undefined
    return (
        validModel(settings.modelOverrides?.[taskType]) ??
        validModel(config.model) ??
        PROVIDER_DEFAULT_MODELS[provider] ??
        DEFAULT_MODEL_ROUTING[taskType]
    )
}

interface Scored {
    provider: ProviderKey
    model: string
    entry: ManifestEntry
    score: number
    priorScore: number
    successRate: number
    /** True iff the candidate is currently in cooldown. */
    cooling: boolean
    cooldownEndAt: number
    /** P95 latency observed (ms). */
    p95Ms: number
    recentFailurePenalty: number
}

function scoreCandidate(scored: { priorScore: number; successRate: number; p95Ms: number; recentFailurePenalty: number }): number {
    // ADR 0012 §C6 Q1: hybrid = static prior, refined by 7-day stats.
    // priorScore (1-5) is multiplied by a success-rate multiplier in [0.5, 1.0]
    // so a healthy provider keeps its full prior; a failing one drops toward half.
    // Latency + recent-tail penalty are additive on top so transient regressions
    // bias against a candidate without erasing its long-run reputation.
    const successMultiplier = 0.5 + 0.5 * Math.max(0, Math.min(1, scored.successRate))
    const latencyPenalty = Math.min(1, Math.max(0, (scored.p95Ms - 1000) / 9000))
    return scored.priorScore * successMultiplier - latencyPenalty * 0.3 - scored.recentFailurePenalty * 0.2
}

function whyNotPicked(c: Scored, top: Scored): string {
    if (c.cooling) {
        const secs = Math.max(0, Math.round((c.cooldownEndAt - Date.now()) / 1000))
        return `in cooldown for ${secs}s`
    }
    if (c.priorScore < top.priorScore) {
        return `lower manifest prior (${c.priorScore} vs ${top.priorScore})`
    }
    if (c.recentFailurePenalty > 0.3) {
        return `recent failure rate ${(c.recentFailurePenalty * 100).toFixed(0)}%`
    }
    if (c.p95Ms > 5000) {
        return `p95 latency ${c.p95Ms}ms`
    }
    return `lower composite score (${c.score.toFixed(2)} vs ${top.score.toFixed(2)})`
}

/**
 * Round-4 D2: try to resolve a forced model from `modelIdOverride` against the
 * configured providers. Returns a ChosenModel (bypassing scoring) when the model
 * maps to an available provider that has a manifest entry for this task type;
 * null otherwise (caller falls through to normal scoring).
 */
function resolveForcedModel(
    modelIdOverride: string,
    availableProviders: AvailableProvider[],
    taskType: TaskType,
    settings: WorkspaceAISettings,
): ChosenModel | null {
    const trimmed = modelIdOverride.trim()
    if (trimmed === '') return null
    const slash = trimmed.indexOf('/')
    const wantProvider = slash > 0 ? trimmed.slice(0, slash) : null
    const wantModel = slash > 0 ? trimmed.slice(slash + 1) : trimmed

    for (const ap of availableProviders) {
        if (wantProvider && ap.provider !== wantProvider) continue
        const resolved = resolveModelId(ap.provider, ap.config, taskType, settings)
        const matches = wantProvider !== null || resolved === wantModel || ap.config.model === wantModel
        if (!matches) continue
        const entry = getManifestEntry(taskType, ap.provider)
        if (!entry) continue // need an entry for cascade params; else fall through to scoring
        return {
            provider: ap.provider,
            model: wantProvider !== null ? wantModel : (resolved ?? wantModel),
            score: 0,
            priorScore: entry.priorScore,
            manifestEntry: entry,
        }
    }
    return null
}

export function selectModel(input: SelectInput): SelectionResult {
    const { workspaceId, taskType, availableProviders, settings, modelIdOverride } = input
    const now = Date.now()

    // D2 forced model: highest precedence, bypasses scoring. Falls through to
    // normal selection when the forced model isn't an available provider (e.g.
    // it failed and was excluded from the cascade pool).
    if (modelIdOverride) {
        const forced = resolveForcedModel(modelIdOverride, availableProviders, taskType, settings)
        if (forced) {
            return {
                chosen: forced,
                alternatives: [],
                rationale: `${forced.provider}/${forced.model} forced via modelIdOverride (bypassed scoring).`,
                manifestVersion,
                requireOperatorAction: false,
                noManifestMatch: false,
                forcedModel: true,
            }
        }
    }

    const scoredAll: Scored[] = []
    for (const ap of availableProviders) {
        const entry = getManifestEntry(taskType, ap.provider)
        if (!entry) continue
        const modelId = resolveModelId(ap.provider, ap.config, taskType, settings)
        if (entry.hardSkipPredicate?.({ workspaceId, taskType, modelId })) continue

        const stats = getStats({ workspaceId, provider: ap.provider, model: modelId, taskType })
        const cooling = stats.cooldownEndAt > now
        const sc: Scored = {
            provider: ap.provider,
            model: modelId,
            entry,
            priorScore: entry.priorScore,
            successRate: stats.successRate,
            p95Ms: stats.latencyP95Ms,
            recentFailurePenalty: stats.recentFailurePenalty,
            cooling,
            cooldownEndAt: stats.cooldownEndAt,
            score: 0,
        }
        sc.score = scoreCandidate(sc)
        scoredAll.push(sc)
    }

    if (scoredAll.length === 0) {
        return {
            chosen: null,
            alternatives: [],
            rationale: 'No candidate provider has a manifest entry for this task type.',
            manifestVersion,
            requireOperatorAction: false,
            noManifestMatch: true,
        }
    }

    // Single-provider rule (2026-06-07): low manifest quality is NEVER a hard
    // block. A workspace must be usable with whatever provider it has connected,
    // even for high-stakes tasks. Below-bar candidates fall through to normal
    // selection and surface `degradationReason` (non-blocking). The former
    // Q2-hybrid `requireOperatorAction` block was removed because it dead-ended
    // single-provider / all-low-quality workspaces.

    // Prefer non-cooling candidates first; fall through to cooling only when all are.
    const nonCooling = scoredAll.filter(c => !c.cooling)
    const pool = nonCooling.length > 0 ? nonCooling : scoredAll
    pool.sort((a, b) => b.score - a.score)

    const top = pool[0]!
    const next = pool.slice(1, 3)
    const alternatives: Alternative[] = next.map(c => ({
        provider: c.provider,
        model: c.model,
        score: c.score,
        priorScore: c.priorScore,
        whyNotPicked: whyNotPicked(c, top),
    }))

    const reason: string[] = []
    reason.push(`prior=${top.priorScore}/5`)
    if (top.p95Ms > 0) reason.push(`p95=${top.p95Ms}ms`)
    if (top.successRate < 1) reason.push(`success=${(top.successRate * 100).toFixed(0)}%`)
    if (top.recentFailurePenalty > 0) reason.push(`recent-fail=${(top.recentFailurePenalty * 100).toFixed(0)}%`)
    const altSummary = alternatives.length > 0
        ? `; next: ${alternatives.map(a => `${a.provider} (${a.whyNotPicked})`).join(', ')}`
        : ''
    const rationale = `${top.provider}/${top.model} picked: ${reason.join(', ')}${altSummary}.`

    const degradationReason: 'workspace_low_quality_only' | undefined =
        top.priorScore < RECOMMENDED_PRIOR ? 'workspace_low_quality_only' : undefined

    return {
        chosen: {
            provider: top.provider,
            model: top.model,
            score: top.score,
            priorScore: top.priorScore,
            manifestEntry: top.entry,
        },
        alternatives,
        rationale,
        manifestVersion,
        requireOperatorAction: false,
        noManifestMatch: false,
        degradationReason,
    }
}
