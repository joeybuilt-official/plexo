// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing-defaults helper — Phase 2b of the intelligence overhaul.
 *
 * Pure helper that turns a workspace's enabled provider instances + the
 * 506-row models_knowledge catalog into a smart-default fallback chain
 * per task type. The seeder + the `POST /chains/:taskType/reset` endpoint
 * both call this so the same logic governs first-boot seeding and
 * user-triggered resets.
 *
 * Hard invariant: `deepseek-reasoner` (and any other reasoner-class model
 * id) MUST NEVER appear at position 0 in the chains for the
 * `REASONER_NEVER_TIERS` task types — conversation, classification,
 * summarization, codeGeneration, verification, logAnalysis. This mirrors
 * the auto-swap matrix in `packages/agent/src/providers/registry.ts:238`
 * (Phase 0). The router would still swap at execution time even if it
 * landed wrong, but the chain editor must not surface a default chain
 * that suggests this configuration is OK.
 *
 * The helper is fully deterministic, takes no I/O, and does not import
 * from `@plexo/db` or `@plexo/agent` so it can be unit-tested with no
 * mocks. Tests pin the reasoner-never invariant + the score ordering.
 */

import { computeModelAttributes, type ModelKnowledgeInput, type ModelAttributes } from './model-attributes.js'

// ── Types ─────────────────────────────────────────────────────────────────

/** Subset of provider_instances rows the seeder cares about. */
export interface EnabledProvider {
    id: string
    providerType: string
    enabled: boolean
    /** Human-curated chat models the discovery layer pulled. */
    chatModels: string[]
    /** Per-instance "selectedModel" override (the user's pinned default). */
    selectedModel: string | null
}

/** Subset of models_knowledge rows the seeder cares about. */
export interface CatalogModel extends ModelKnowledgeInput {
    /**
     * `${provider}/${modelId}` — the primary key in models_knowledge.
     * Carried through unchanged for join debugging.
     */
    id: string
    reliabilityScore: number
}

export type RoutingTaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'conversation'
    | 'classification'
    | 'logAnalysis'

export const ROUTING_TASK_TYPES: readonly RoutingTaskType[] = [
    'planning',
    'codeGeneration',
    'verification',
    'summarization',
    'conversation',
    'classification',
    'logAnalysis',
] as const

/**
 * Tiers where a reasoner model MUST NEVER occupy position 0. Mirror of
 * `REASONER_NEVER_TIERS` in providers/registry.ts. Reasoner is only
 * acceptable as a non-zero fallback in `planning`.
 */
export const REASONER_NEVER_TIERS: ReadonlySet<RoutingTaskType> = new Set([
    'conversation',
    'classification',
    'summarization',
    'codeGeneration',
    'verification',
    'logAnalysis',
])

/** Model ids treated as "reasoner-class" — substring match, lowercased. */
const REASONER_PATTERNS = [
    'deepseek-reasoner',
    'o1-pro',
    'o1-preview',
    'o1-mini',
    'o3',
] as const

export function isReasonerModelId(modelId: string): boolean {
    const m = modelId.toLowerCase()
    return REASONER_PATTERNS.some(p => m.includes(p))
}

/** A single ranked entry in a default chain. */
export interface DefaultChainEntry {
    providerId: string
    providerType: string
    modelId: string
    /** Score the helper gave this candidate, surfaced for debugging. */
    score: number
}

/** A complete per-task-type chain (max length 3). */
export type DefaultChain = DefaultChainEntry[]

// ── Scoring ───────────────────────────────────────────────────────────────

/**
 * Per-task-type scoring weights. Higher weights → that signal dominates.
 *
 *   reasoning : how much the task benefits from chain-of-thought
 *   speed     : how much the task wants low first-token latency
 *   cheap     : how much the task is high-volume and cost-sensitive
 *   code      : how much the task wants a coding-tuned model
 *   tools     : how much the task expects tool calls
 *   long_ctx  : how much the task wants 128k+ context
 */
interface TaskWeights {
    reasoning: number
    speed: number
    cheap: number
    code: number
    tools: number
    longContext: number
}

const WEIGHTS: Record<RoutingTaskType, TaskWeights> = {
    planning:       { reasoning: 5, speed: 0, cheap: 0, code: 1, tools: 1, longContext: 2 },
    codeGeneration: { reasoning: 1, speed: 1, cheap: 0, code: 5, tools: 2, longContext: 2 },
    verification:   { reasoning: 2, speed: 1, cheap: 1, code: 2, tools: 2, longContext: 1 },
    summarization:  { reasoning: 0, speed: 3, cheap: 3, code: 0, tools: 0, longContext: 3 },
    conversation:   { reasoning: 0, speed: 4, cheap: 3, code: 0, tools: 1, longContext: 0 },
    classification: { reasoning: 0, speed: 5, cheap: 4, code: 0, tools: 0, longContext: 0 },
    logAnalysis:    { reasoning: 0, speed: 3, cheap: 3, code: 0, tools: 0, longContext: 2 },
}

/**
 * Score a single (model, task) candidate. Higher is better. The score is
 * a linear combination of:
 *   - matched weight signals from the task tier
 *   - reliabilityScore (catalog freshness / past success)
 *   - cost penalty (premium models lose ground on cheap tiers)
 *   - reasoner penalty for REASONER_NEVER_TIERS so they sink past usable
 *     chat models even when their other signals look good
 */
export function scoreCandidate(
    attrs: ModelAttributes,
    reliability: number,
    taskType: RoutingTaskType,
): number {
    const w = WEIGHTS[taskType]
    let score = 0

    if (attrs.strengths.includes('reasoning')) score += w.reasoning
    if (attrs.strengths.includes('speed') || attrs.latencyClass === 'fast') score += w.speed
    if (attrs.strengths.includes('cheap') || attrs.costClass === 'free' || attrs.costClass === 'cheap') score += w.cheap
    if (attrs.strengths.includes('code')) score += w.code
    if (attrs.capabilities.includes('tools')) score += w.tools
    if (attrs.capabilities.includes('long_context')) score += w.longContext

    // Reliability nudge — small but breaks ties towards models that
    // recently worked.
    score += Math.max(0, Math.min(1, reliability)) * 0.5

    // Cost penalty for high-volume tiers — premium loses 2 points on
    // conversation/classification, otherwise just 0.5.
    if (attrs.costClass === 'premium') {
        const heavyTraffic = taskType === 'conversation' || taskType === 'classification' || taskType === 'summarization'
        score -= heavyTraffic ? 2 : 0.5
    }

    // Latency penalty for chat-class tiers when the model is slow.
    if (attrs.latencyClass === 'slow') {
        const wantsFast = taskType === 'conversation' || taskType === 'classification'
        if (wantsFast) score -= 3
    }

    // Reasoner sink for never-tiers. The penalty is large enough that
    // even a high-capability reasoner cannot overtake a vanilla chat
    // model. Tests pin this invariant.
    if (REASONER_NEVER_TIERS.has(taskType) && isReasonerModelId(attrs.modelId)) {
        score -= 100
    }

    return score
}

// ── Catalog filtering ─────────────────────────────────────────────────────

interface CandidateRow {
    providerId: string
    providerType: string
    modelId: string
    attrs: ModelAttributes
    reliability: number
    /**
     * Soft preference bonus — `selectedModel` for the provider scores
     * slightly higher so a workspace's pinned chat default lands at
     * position 0 absent a strong overriding signal.
     */
    pinned: boolean
}

/**
 * Build the candidate set for one workspace: every (enabled provider,
 * known model) combination where the catalog has the model + the
 * provider can serve it.
 *
 * If the catalog is missing a row for a (provider, model) pair, we
 * synthesize a minimal entry from name patterns so the seeder still
 * produces a chain on a workspace whose providers exist but whose
 * models_knowledge is sparse. The synthesized rows score lower than
 * catalog rows because their reliability is 0.5 by default.
 */
export function buildCandidates(
    providers: EnabledProvider[],
    catalog: CatalogModel[],
): CandidateRow[] {
    const out: CandidateRow[] = []
    const catalogIndex = new Map<string, CatalogModel>()
    for (const row of catalog) {
        catalogIndex.set(`${row.provider}/${row.modelId}`, row)
    }

    for (const provider of providers) {
        if (!provider.enabled) continue
        const modelIds = new Set<string>(provider.chatModels ?? [])
        if (provider.selectedModel) modelIds.add(provider.selectedModel)
        if (modelIds.size === 0) continue

        for (const modelId of modelIds) {
            const key = `${provider.providerType}/${modelId}`
            const catalogRow = catalogIndex.get(key)
            const attrs = catalogRow
                ? computeModelAttributes(catalogRow)
                : computeModelAttributes(synthesizeRow(provider.providerType, modelId))
            out.push({
                providerId: provider.id,
                providerType: provider.providerType,
                modelId,
                attrs,
                reliability: catalogRow?.reliabilityScore ?? 0.5,
                pinned: provider.selectedModel === modelId,
            })
        }
    }
    return out
}

function synthesizeRow(provider: string, modelId: string): ModelKnowledgeInput {
    // Crude name-pattern fallback for catalog gaps. The strengths array
    // is populated from substring matches on the model id so the
    // computeModelAttributes helper can still derive useful badges.
    const m = modelId.toLowerCase()
    const strengths: string[] = []
    if (/(reasoner|o1|o3)/.test(m)) strengths.push('reasoning')
    if (/(haiku|mini|flash|nano|8b|small|lite)/.test(m)) strengths.push('speed', 'cheap')
    if (/(code|coder)/.test(m)) strengths.push('code')
    if (/(tool|function)/.test(m)) strengths.push('tools')
    return {
        provider,
        modelId,
        contextWindow: 128_000,
        costPerMIn: 0,
        costPerMOut: 0,
        strengths,
    }
}

// ── Default chain assembly ────────────────────────────────────────────────

/**
 * Compute the default chain for one task type. Picks the top 3 distinct
 * (provider, model) candidates by score, breaking ties by pinned-status
 * and then by alphabetical model id for stability across runs.
 *
 * Position 0 in REASONER_NEVER_TIERS chains is guaranteed not to be a
 * reasoner-class model — both because the scoring penalty pushes them
 * down and because we re-sweep the head of the list to defend against
 * a pathological case where every catalog model is a reasoner.
 */
export function computeDefaultChainForTask(
    candidates: CandidateRow[],
    taskType: RoutingTaskType,
): DefaultChain {
    const ranked = candidates
        .map((c) => ({
            ...c,
            score: scoreCandidate(c.attrs, c.reliability, taskType),
        }))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
            return a.modelId.localeCompare(b.modelId)
        })

    // Defensive head-sweep for never-tiers: if the top candidate is
    // somehow still a reasoner (e.g. only reasoner models exist),
    // swap it for the first non-reasoner candidate. If none exist,
    // we leave the chain empty for this tier — better than seeding a
    // wrong default.
    let chain = ranked
    if (REASONER_NEVER_TIERS.has(taskType) && chain[0] && isReasonerModelId(chain[0].modelId)) {
        const firstSafe = chain.findIndex(c => !isReasonerModelId(c.modelId))
        if (firstSafe > 0) {
            const safe = chain[firstSafe]!
            chain = [safe, ...chain.slice(0, firstSafe), ...chain.slice(firstSafe + 1)]
        } else {
            chain = chain.filter(c => !isReasonerModelId(c.modelId))
        }
    }

    return chain.slice(0, 3).map(c => ({
        providerId: c.providerId,
        providerType: c.providerType,
        modelId: c.modelId,
        score: c.score,
    }))
}

/**
 * Compute every default chain for one workspace. Returns a map keyed
 * by task type. Empty chains are included so the caller can tell the
 * difference between "we tried" and "we never looked".
 */
export function computeDefaultChainsForWorkspace(
    providers: EnabledProvider[],
    catalog: CatalogModel[],
): Record<RoutingTaskType, DefaultChain> {
    const candidates = buildCandidates(providers, catalog)
    const out = {} as Record<RoutingTaskType, DefaultChain>
    for (const taskType of ROUTING_TASK_TYPES) {
        out[taskType] = computeDefaultChainForTask(candidates, taskType)
    }
    return out
}
