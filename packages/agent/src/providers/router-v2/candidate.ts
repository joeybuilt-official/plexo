// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — model candidate + capability derivation (Round-6 Phase 0).
 *
 * Pure data foundation for the model-level router. Defines `ModelCandidate`
 * (one concrete model on one provider) and `deriveCapabilities`, which
 * normalizes the heterogeneous signals we already collect — `models_knowledge`
 * `strengths[]` (from the Portkey sync, see providers/knowledge.ts), the
 * per-(task,provider) `manifest` capabilities, and provider quirks — into the
 * canonical `Capability` set the future capability gate (Phase 1) filters on.
 *
 * No selection logic and no DB access here. ADR 0006, Round-6 plan Phase 0.
 */

import type { Capability, ProviderQuirk } from './manifest.js'
import type { ProviderKey, TaskType } from '../registry.js'

/**
 * One concrete model on one connected provider, enriched with everything the
 * model-level router needs to gate + score it. `priorScoreByTask` is sparse:
 * the manifest only scores a handful of model classes, so most candidates have
 * priors only for the tasks their class is manifested for.
 */
export interface ModelCandidate {
    provider: ProviderKey
    modelId: string
    /** Normalized capability set (see deriveCapabilities). */
    capabilities: ReadonlySet<Capability>
    /** Max context window in tokens. */
    contextWindow: number
    /** USD per 1M input tokens. */
    costPerMIn: number
    /** USD per 1M output tokens. */
    costPerMOut: number
    /** 0..1 reliability prior from models_knowledge.reliability_score. */
    reliability: number
    /** Static manifest prior (1-5) keyed by task type; sparse. */
    priorScoreByTask: Partial<Record<TaskType, number>>
}

/**
 * `models_knowledge.strengths[]` vocabulary → canonical Capability.
 * Strengths the sync emits but which describe *quality*, not a hard
 * capability flag (`reasoning`, `coding`, `open-source`, `video`), are
 * intentionally absent — they don't gate, they inform scoring (Phase 2).
 * Source vocabulary: providers/knowledge.ts syncModelKnowledge.
 */
export const STRENGTH_TO_CAPABILITY: Readonly<Record<string, Capability>> = {
    vision: 'vision',
    tools: 'tool-calling',
    structured_output: 'json-mode',
    speed: 'low-latency',
}

/**
 * Provider quirks that imply a hard capability. Kept narrow: only quirks that
 * genuinely guarantee a capability belong here.
 */
const QUIRK_TO_CAPABILITY: Readonly<Partial<Record<ProviderQuirk, Capability[]>>> = {
    'openai-strict-json-mode': ['function-calling-strict', 'json-mode'],
}

/** Context-window thresholds → long-context capability flags. */
const LONG_CONTEXT_1M = 1_000_000
const LONG_CONTEXT_200K = 200_000

export interface DeriveCapabilitiesInput {
    /** Raw models_knowledge.strengths[] (unknown entries ignored). */
    strengths?: readonly string[]
    /** models_knowledge.context_window. */
    contextWindow?: number
    /** Capabilities asserted by the manifest entry for this model class. */
    manifestCapabilities?: readonly Capability[]
    /** Provider quirks (some imply a hard capability). */
    quirks?: readonly ProviderQuirk[]
}

/**
 * Fold the available signals into a single normalized Capability set. Union
 * semantics: a capability asserted by *any* source is present. Pure.
 */
export function deriveCapabilities(input: DeriveCapabilitiesInput): Set<Capability> {
    const caps = new Set<Capability>()

    for (const s of input.strengths ?? []) {
        const cap = STRENGTH_TO_CAPABILITY[s]
        if (cap) caps.add(cap)
    }

    const ctx = input.contextWindow ?? 0
    if (ctx >= LONG_CONTEXT_1M) caps.add('long-context-1m')
    if (ctx >= LONG_CONTEXT_200K) caps.add('long-context-200k')

    for (const cap of input.manifestCapabilities ?? []) caps.add(cap)

    for (const q of input.quirks ?? []) {
        for (const cap of QUIRK_TO_CAPABILITY[q] ?? []) caps.add(cap)
    }

    return caps
}

export interface BuildCandidateInput {
    provider: ProviderKey
    modelId: string
    /** From the matched models_knowledge row, when present. */
    knowledge?: {
        contextWindow?: number
        costPerMIn?: number
        costPerMOut?: number
        strengths?: readonly string[]
        reliabilityScore?: number
    }
    /** Manifest capabilities for this model class (any task), merged into caps. */
    manifestCapabilities?: readonly Capability[]
    quirks?: readonly ProviderQuirk[]
    /** Per-task manifest priors for this provider's class. */
    priorScoreByTask?: Partial<Record<TaskType, number>>
}

/**
 * Assemble a ModelCandidate from a (provider, model) plus its optional
 * knowledge row and manifest signals. Missing knowledge degrades gracefully:
 * caps still derive from manifest/quirks, cost/context default to 0 (the gate +
 * scorer treat 0-context as "unknown, don't long-context-gate it out").
 */
export function buildModelCandidate(input: BuildCandidateInput): ModelCandidate {
    const k = input.knowledge ?? {}
    return {
        provider: input.provider,
        modelId: input.modelId,
        capabilities: deriveCapabilities({
            strengths: k.strengths,
            contextWindow: k.contextWindow,
            manifestCapabilities: input.manifestCapabilities,
            quirks: input.quirks,
        }),
        contextWindow: k.contextWindow ?? 0,
        costPerMIn: k.costPerMIn ?? 0,
        costPerMOut: k.costPerMOut ?? 0,
        reliability: k.reliabilityScore ?? 1,
        priorScoreByTask: input.priorScoreByTask ?? {},
    }
}
