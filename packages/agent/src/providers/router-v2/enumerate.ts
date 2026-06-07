// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — model candidate enumeration + capability gate (Round-6 Phase 1).
 *
 * Pure + DB-free. The caller (impure, in index.ts) pre-fetches `models_knowledge`
 * rows and discovered model ids and injects them here. This keeps the hot path
 * unit-testable and memoizable, holding the <50ms p95 selector budget (Pat).
 *
 * Candidate source (operator decision #3): (configured ∪ discovered for connected
 * providers) ∩ `models_knowledge` for capability/cost — EXCEPT the configured/
 * resolved model is ALWAYS a candidate even without a knowledge row, so a
 * single-provider workspace never enumerates to empty (ADR 0005). Manifest
 * supplies the per-class task-fit prior + capabilities.
 *
 * No scoring + no selection here (Phase 2). ADR 0006, Round-6 plan Phase 1.
 */

import { MANIFEST, getManifestEntry, type Capability } from './manifest.js'
import { buildModelCandidate, type ModelCandidate } from './candidate.js'
import { resolveModelId, type AvailableProvider } from './selector.js'
import {
    DEFAULT_MODEL_ROUTING,
    type ProviderKey,
    type TaskType,
    type WorkspaceAISettings,
} from '../registry.js'

const TASK_TYPES = Object.keys(DEFAULT_MODEL_ROUTING) as TaskType[]

/** A pre-fetched models_knowledge row (subset the enumerator needs). */
export interface KnowledgeRow {
    provider: string
    modelId: string
    contextWindow?: number
    costPerMIn?: number
    costPerMOut?: number
    strengths?: readonly string[]
    reliabilityScore?: number
}

export interface EnumerateInput {
    taskType: TaskType
    /** Connected providers + their config (same shape the selector consumes). */
    availableProviders: AvailableProvider[]
    settings: WorkspaceAISettings
    /** Pre-fetched models_knowledge rows for the connected providers. */
    knowledge: readonly KnowledgeRow[]
    /** Discovered chat model ids per provider (provider_instances.capabilities.chatModels). */
    discovered?: Partial<Record<ProviderKey, readonly string[]>>
    /** Max candidates returned (latency cap). Default 12. */
    cap?: number
}

const DEFAULT_CAP = 12

const key = (provider: string, modelId: string) => `${provider}::${modelId}`

/** Collect this provider class's manifest priors across every task type (sparse). */
function priorsForProvider(provider: ProviderKey): Partial<Record<TaskType, number>> {
    const out: Partial<Record<TaskType, number>> = {}
    for (const t of TASK_TYPES) {
        const entry = MANIFEST[t]?.[provider]
        if (entry) out[t] = entry.priorScore
    }
    return out
}

/**
 * Enumerate candidate models across the connected providers for this task.
 *
 * Guarantees:
 * - each provider's configured/resolved model is always present (single-provider rule),
 * - discovered/configured models are otherwise included only when they have a
 *   knowledge row (candidate-source decision #3),
 * - deduped by (provider, modelId),
 * - capped at `cap`, but the per-provider configured models are pinned and never
 *   evicted by the cap; the remaining slots go to the highest task-prior candidates.
 */
export function enumerateModelCandidates(input: EnumerateInput): ModelCandidate[] {
    const { taskType, availableProviders, settings, knowledge, discovered } = input
    const cap = input.cap ?? DEFAULT_CAP

    const knowledgeIndex = new Map<string, KnowledgeRow>()
    for (const row of knowledge) knowledgeIndex.set(key(row.provider, row.modelId), row)

    const pinned: ModelCandidate[] = []
    const extra: ModelCandidate[] = []
    const seen = new Set<string>()

    const make = (provider: ProviderKey, modelId: string): ModelCandidate => {
        const entry = getManifestEntry(taskType, provider)
        const k = knowledgeIndex.get(key(provider, modelId))
        return buildModelCandidate({
            provider,
            modelId,
            knowledge: k
                ? {
                      contextWindow: k.contextWindow,
                      costPerMIn: k.costPerMIn,
                      costPerMOut: k.costPerMOut,
                      strengths: k.strengths,
                      reliabilityScore: k.reliabilityScore,
                  }
                : undefined,
            manifestCapabilities: entry?.capabilities,
            quirks: entry?.quirks,
            priorScoreByTask: priorsForProvider(provider),
        })
    }

    for (const ap of availableProviders) {
        const provider = ap.provider

        // Always-keep: the model this provider would actually serve today.
        const resolved = resolveModelId(provider, ap.config, taskType, settings)
        const resolvedKey = key(provider, resolved)
        if (!seen.has(resolvedKey)) {
            seen.add(resolvedKey)
            pinned.push(make(provider, resolved))
        }

        // configured ∪ discovered, gated to ∩ knowledge (resolved already pinned above).
        const others = new Set<string>()
        if (ap.config.model) others.add(ap.config.model)
        for (const m of discovered?.[provider] ?? []) others.add(m)
        for (const modelId of others) {
            const k = key(provider, modelId)
            if (seen.has(k)) continue
            if (!knowledgeIndex.has(k)) continue // ∩ knowledge for non-configured candidates
            seen.add(k)
            extra.push(make(provider, modelId))
        }
    }

    if (pinned.length >= cap) return pinned

    const priorOf = (c: ModelCandidate) => c.priorScoreByTask[taskType] ?? 0
    extra.sort((a, b) => priorOf(b) - priorOf(a))
    return [...pinned, ...extra].slice(0, cap)
}

/**
 * Hard capability filter. Keeps only candidates supporting every required
 * capability. Single-provider rule: if the filter would empty the set, return
 * the unfiltered candidates instead (never block a workspace out of routing).
 */
export function capabilityGate(
    required: readonly Capability[],
    candidates: readonly ModelCandidate[],
): ModelCandidate[] {
    if (required.length === 0) return [...candidates]
    const pass = candidates.filter(c => required.every(r => c.capabilities.has(r)))
    return pass.length > 0 ? pass : [...candidates]
}
