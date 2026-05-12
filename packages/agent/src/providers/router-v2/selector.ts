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
 *   3. Q2 hybrid: high-stakes task + all candidates < LOW_QUALITY_THRESHOLD →
 *      requireOperatorAction. Other task types route through anyway.
 *   4. Score = qualityScore × 1.0 − latencyP95Penalty × 0.3 − recentFailurePenalty × 0.2.
 *   5. chosen = top scorer; alternatives = next 2 with reason.
 *
 * Must return within 50ms p95 (first principle #1).
 */

import {
    HIGH_STAKES_TASK_TYPES,
    LOW_QUALITY_THRESHOLD,
    PROVIDER_DEFAULT_MODEL_CLASS,
    getManifestEntry,
    manifestVersion,
    type ManifestEntry,
} from './manifest.js'
import { getStats } from './stats.js'
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
    qualityScore: number
    whyNotPicked: string
}

export interface ChosenModel {
    provider: ProviderKey
    model: string
    score: number
    qualityScore: number
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
}

export interface SelectInput {
    workspaceId: string | undefined
    taskType: TaskType
    /** Providers the workspace has configured + we should consider. Order is honored as a soft prior. */
    availableProviders: AvailableProvider[]
    settings: WorkspaceAISettings
}

/** Resolve the concrete model ID this candidate would call. */
function resolveModelId(
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
    qualityScore: number
    /** True iff the candidate is currently in cooldown. */
    cooling: boolean
    cooldownEndAt: number
    /** P95 latency observed (ms). */
    p95Ms: number
    recentFailurePenalty: number
}

function scoreCandidate(scored: { qualityScore: number; p95Ms: number; recentFailurePenalty: number }): number {
    // Normalize latency penalty: 0 below 1s, scales linearly to 1.0 at 10s+
    const latencyPenalty = Math.min(1, Math.max(0, (scored.p95Ms - 1000) / 9000))
    return scored.qualityScore * 1.0 - latencyPenalty * 0.3 - scored.recentFailurePenalty * 0.2
}

function whyNotPicked(c: Scored, top: Scored): string {
    if (c.cooling) {
        const secs = Math.max(0, Math.round((c.cooldownEndAt - Date.now()) / 1000))
        return `in cooldown for ${secs}s`
    }
    if (c.qualityScore < top.qualityScore) {
        return `lower manifest quality (${c.qualityScore} vs ${top.qualityScore})`
    }
    if (c.recentFailurePenalty > 0.3) {
        return `recent failure rate ${(c.recentFailurePenalty * 100).toFixed(0)}%`
    }
    if (c.p95Ms > 5000) {
        return `p95 latency ${c.p95Ms}ms`
    }
    return `lower composite score (${c.score.toFixed(2)} vs ${top.score.toFixed(2)})`
}

export function selectModel(input: SelectInput): SelectionResult {
    const { workspaceId, taskType, availableProviders, settings } = input
    const now = Date.now()

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
            qualityScore: entry.qualityScore,
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

    // Q2 hybrid: block + prompt only for high-stakes tasks when NO candidate
    // (cooling or not) meets the quality bar.
    const highStakes = HIGH_STAKES_TASK_TYPES.has(taskType)
    const anyMeetsBar = scoredAll.some(c => c.qualityScore >= LOW_QUALITY_THRESHOLD)
    if (highStakes && !anyMeetsBar) {
        return {
            chosen: null,
            alternatives: [],
            rationale: `No installed provider meets quality bar (≥${LOW_QUALITY_THRESHOLD}) for high-stakes task "${taskType}". Operator action required.`,
            manifestVersion,
            requireOperatorAction: true,
            noManifestMatch: false,
        }
    }

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
        qualityScore: c.qualityScore,
        whyNotPicked: whyNotPicked(c, top),
    }))

    const reason: string[] = []
    reason.push(`quality=${top.qualityScore}/5`)
    if (top.p95Ms > 0) reason.push(`p95=${top.p95Ms}ms`)
    if (top.recentFailurePenalty > 0) reason.push(`recent-fail=${(top.recentFailurePenalty * 100).toFixed(0)}%`)
    const altSummary = alternatives.length > 0
        ? `; next: ${alternatives.map(a => `${a.provider} (${a.whyNotPicked})`).join(', ')}`
        : ''
    const rationale = `${top.provider}/${top.model} picked: ${reason.join(', ')}${altSummary}.`

    return {
        chosen: {
            provider: top.provider,
            model: top.model,
            score: top.score,
            qualityScore: top.qualityScore,
            manifestEntry: top.entry,
        },
        alternatives,
        rationale,
        manifestVersion,
        requireOperatorAction: false,
        noManifestMatch: false,
    }
}
