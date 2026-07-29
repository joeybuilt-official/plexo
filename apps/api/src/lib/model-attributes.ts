// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model attribute computer — Phase 2a foundation.
 *
 * Pure helper that turns a `models_knowledge` row (or any compatible
 * shape) into a stable, UI-friendly `ModelAttributes` record. Phase 2b's
 * catalog browser drops directly on top of this; Phase 2a's routing
 * surfaces use it for the badge component.
 *
 * Single source of truth for "what does this model do well" so badges,
 * tooltips, sort orders, and the chain editor (Phase 2b) all agree.
 *
 * Inputs are read-only; this module never touches the DB. Tests pin
 * the deterministic mapping from strengths → capabilities/tags + the
 * latency/cost class boundaries.
 */

export type CapabilityFlag = 'tools' | 'vision' | 'json_mode' | 'long_context'
export type StrengthTag =
    | 'reasoning'
    | 'speed'
    | 'cheap'
    | 'code'
    | 'multilingual'
    | 'open_source'
    | 'creative'
export type LatencyClass = 'fast' | 'medium' | 'slow'
export type CostClass = 'free' | 'cheap' | 'standard' | 'premium'

/** Subset of `models_knowledge` that the helper actually needs. */
export interface ModelKnowledgeInput {
    provider: string
    modelId: string
    contextWindow: number
    costPerMIn: number
    costPerMOut: number
    strengths: string[]
}

export interface ModelAttributes {
    provider: string
    modelId: string
    capabilities: CapabilityFlag[]
    strengths: StrengthTag[]
    latencyClass: LatencyClass
    costClass: CostClass
    contextWindow: number
    /** Average $/M tokens — used for sort + display. */
    blendedCostPerM: number
    /** Single-sentence "best for" hint. Empty string if nothing distinctive. */
    bestForHint: string
}

/**
 * Cost class buckets, in average $/M tokens (in+out blended).
 *   free      <= 0.001    — open-weights via free tiers, deepseek-chat, gemini flash
 *   cheap     <= 0.50     — gpt-4o-mini, haiku, llama-70b on Groq
 *   standard  <= 5.00     — gpt-4o, sonnet, gemini pro
 *   premium   >  5.00     — opus, o1, gpt-4
 */
export function classifyCost(blendedPerM: number): CostClass {
    if (blendedPerM <= 0.001) return 'free'
    if (blendedPerM <= 0.5) return 'cheap'
    if (blendedPerM <= 5) return 'standard'
    return 'premium'
}

/**
 * Latency class — heuristic. We don't have measured p50 latency in
 * `models_knowledge` yet (Phase 5 visibility dashboard adds it from
 * inference_logs). Until then, infer from the model id + provider:
 *   - Groq / Cerebras hardware → fast
 *   - "mini", "haiku", "flash", "8b" → fast
 *   - "reasoner", "o1", "o3", "opus" → slow
 *   - everything else → medium
 */
export function classifyLatency(provider: string, modelId: string): LatencyClass {
    const p = provider.toLowerCase()
    const m = modelId.toLowerCase()
    if (p === 'groq' || p === 'cerebras') return 'fast'
    if (/(mini|haiku|flash|8b|nano|small|lite)/.test(m)) return 'fast'
    if (/(reasoner|opus|o1|o3|405b|70b)/.test(m)) return 'slow'
    return 'medium'
}

/** Strength-tag normalisation. Maps the raw strings stored in
 * `models_knowledge.strengths` (which mix capabilities and tags) into
 * the typed UI tag set. Unknown strings are dropped. */
export function normaliseStrengths(raw: string[]): StrengthTag[] {
    const out = new Set<StrengthTag>()
    for (const s of raw) {
        const t = s.toLowerCase()
        if (t === 'reasoning') out.add('reasoning')
        else if (t === 'speed' || t === 'fast') out.add('speed')
        else if (t === 'cheap' || t === 'budget') out.add('cheap')
        else if (t === 'code' || t === 'coding') out.add('code')
        else if (t === 'multilingual') out.add('multilingual')
        else if (t === 'open-source' || t === 'open_source') out.add('open_source')
        else if (t === 'creative' || t === 'writing') out.add('creative')
    }
    return Array.from(out)
}

/** Capability flags derived from raw strengths + heuristics. */
export function deriveCapabilities(input: ModelKnowledgeInput): CapabilityFlag[] {
    const out = new Set<CapabilityFlag>()
    for (const s of input.strengths) {
        const t = s.toLowerCase()
        if (t === 'tools' || t === 'tool_use' || t === 'function_calling') out.add('tools')
        if (t === 'vision' || t === 'image' || t === 'multimodal') out.add('vision')
        if (t === 'structured_output' || t === 'json_mode' || t === 'json') out.add('json_mode')
    }
    if (input.contextWindow >= 128_000) out.add('long_context')
    return Array.from(out)
}

/** Compose a one-line "best for" hint from the strongest signals. */
export function composeBestForHint(
    strengths: StrengthTag[],
    latency: LatencyClass,
    cost: CostClass,
): string {
    if (strengths.includes('reasoning') && latency !== 'fast') return 'Deep reasoning, multi-step planning'
    if (strengths.includes('code')) return 'Code generation and refactoring'
    if (latency === 'fast' && (cost === 'free' || cost === 'cheap')) return 'High-throughput conversation, classification'
    if (strengths.includes('creative')) return 'Creative writing, long-form'
    if (strengths.includes('multilingual')) return 'Multilingual translation and chat'
    if (cost === 'premium') return 'Highest-quality output for critical tasks'
    return ''
}

/** Main entry point: compute the full ModelAttributes record. */
export function computeModelAttributes(input: ModelKnowledgeInput): ModelAttributes {
    const blended = (input.costPerMIn + input.costPerMOut) / 2
    const latencyClass = classifyLatency(input.provider, input.modelId)
    const costClass = classifyCost(blended)
    const strengths = normaliseStrengths(input.strengths)
    const capabilities = deriveCapabilities(input)
    return {
        provider: input.provider,
        modelId: input.modelId,
        capabilities,
        strengths,
        latencyClass,
        costClass,
        contextWindow: input.contextWindow,
        blendedCostPerM: blended,
        bestForHint: composeBestForHint(strengths, latencyClass, costClass),
    }
}
