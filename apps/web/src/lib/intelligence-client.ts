// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Phase 2a routing UI.
 *
 * The Settings → Intelligence → Routing surfaces (mode picker, cost-ceiling
 * slider, attribute badges) all flow through this module so the cache key
 * namespace stays consistent. Phase 2b will extend this with chain editor
 * + model catalog hooks under the same `/api/v1/intelligence/...` prefix.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

// ── Types ────────────────────────────────────────────────────────────────

export type InferenceMode = 'auto' | 'byok' | 'proxy' | 'override'
export type CostCeilingMode = 'soft_warn' | 'hard_block' | 'off'
export type CeilingState = 'ok' | 'warn' | 'block'

export type StepBudget = 'conservative' | 'normal' | 'thorough'

export interface IntelligenceSettingsView {
    inferenceMode: InferenceMode
    costCeilingUsd: number | null
    costCeilingMode: CostCeilingMode
    stepBudget: StepBudget
}

export interface CeilingView {
    state: CeilingState
    usagePct: number
    ceilingUsd: number | null
}

export interface IntelligenceSettingsResponse {
    settings: IntelligenceSettingsView
    ceiling: CeilingView
}

export interface WorkspaceSpendView {
    workspaceId: string
    monthStart: string
    pricedUsd: number
    inputTokens: number
    outputTokens: number
    requests: number
    unpricedInputTokens: number
    unpricedOutputTokens: number
    computedAt: string
}

export interface SpendResponse {
    spend: WorkspaceSpendView
    ceiling: CeilingView
}

// ── Hook keys ────────────────────────────────────────────────────────────

export function intelligenceSettingsKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/intelligence/${workspaceId}/settings` : null
}

export function intelligenceSpendKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/intelligence/${workspaceId}/spend` : null
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useIntelligenceSettings(workspaceId: string | null | undefined) {
    return useSWR<IntelligenceSettingsResponse>(
        intelligenceSettingsKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useWorkspaceSpend(workspaceId: string | null | undefined) {
    return useSWR<SpendResponse>(
        intelligenceSpendKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function patchInferenceMode(
    workspaceId: string,
    mode: InferenceMode,
): Promise<{ ok: boolean; inferenceMode: InferenceMode }> {
    const res = await fetch(`/api/v1/intelligence/${workspaceId}/settings/inference-mode`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH inference-mode failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function patchCostCeiling(
    workspaceId: string,
    body: { ceilingUsd?: number | null; mode?: CostCeilingMode },
): Promise<{ ok: boolean; ceilingUsd: number | null; mode: CostCeilingMode | null }> {
    const res = await fetch(`/api/v1/intelligence/${workspaceId}/settings/cost-ceiling`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH cost-ceiling failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function patchStepBudget(
    workspaceId: string,
    budget: StepBudget,
): Promise<{ ok: boolean; stepBudget: StepBudget }> {
    const res = await fetch(`/api/v1/intelligence/${workspaceId}/settings/step-budget`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH step-budget failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

// ── Phase 2b chains ──────────────────────────────────────────────────────

export type RoutingTaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'conversation'
    | 'classification'
    | 'logAnalysis'

export interface ChainEntryView {
    id: string
    providerId: string
    modelId: string
    position: number
}

export interface ChainsResponse {
    chains: Record<RoutingTaskType, ChainEntryView[]>
    taskTypes: RoutingTaskType[]
}

export function intelligenceChainsKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/intelligence/${workspaceId}/chains` : null
}

export function useChains(workspaceId: string | null | undefined) {
    return useSWR<ChainsResponse>(
        intelligenceChainsKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export async function patchChain(
    workspaceId: string,
    taskType: RoutingTaskType,
    entries: Array<{ providerId: string; modelId: string }>,
): Promise<{ ok: boolean; taskType: RoutingTaskType; length: number }> {
    const res = await fetch(`/api/v1/intelligence/${workspaceId}/chains/${taskType}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH chain failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function resetChain(
    workspaceId: string,
    taskType: RoutingTaskType,
): Promise<{ ok: boolean; rowsInserted: number }> {
    const res = await fetch(`/api/v1/intelligence/${workspaceId}/chains/${taskType}/reset`, {
        method: 'POST',
        credentials: 'include',
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Reset chain failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

// ── Phase 2b model catalog ───────────────────────────────────────────────

export interface CatalogItemView {
    id: string
    provider: string
    modelId: string
    capabilities: Array<'tools' | 'vision' | 'json_mode' | 'long_context'>
    strengths: Array<'reasoning' | 'speed' | 'cheap' | 'code' | 'multilingual' | 'open_source' | 'creative'>
    latencyClass: 'fast' | 'medium' | 'slow'
    costClass: 'free' | 'cheap' | 'standard' | 'premium'
    contextWindow: number
    blendedCostPerM: number
    bestForHint: string
    reliabilityScore: number
    lastSyncedAt: string
}

export interface CatalogResponse {
    items: CatalogItemView[]
    total: number
    page: number
    pageSize: number
}

export interface CatalogQuery {
    provider?: string
    q?: string
    capability?: string
    strength?: string
    cost?: string
    latency?: string
    sort?: 'score' | 'cost' | 'context' | 'name'
    page?: number
    pageSize?: number
}

function buildCatalogKey(query: CatalogQuery | undefined): string {
    const params = new URLSearchParams()
    if (!query) return '/api/v1/models/catalog'
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        params.set(key, String(value))
    }
    const qs = params.toString()
    return qs ? `/api/v1/models/catalog?${qs}` : '/api/v1/models/catalog'
}

export function useModelCatalog(query?: CatalogQuery) {
    return useSWR<CatalogResponse>(
        buildCatalogKey(query),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 30_000 },
    )
}

export async function refreshCatalog(): Promise<{ ok: boolean }> {
    const res = await fetch('/api/v1/models/refresh', {
        method: 'POST',
        credentials: 'include',
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Catalog refresh failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export interface RecommendedResponse {
    taskType: RoutingTaskType
    recommended: Array<CatalogItemView & { score: number }>
}

export function useRecommendedModels(taskType: RoutingTaskType | null | undefined) {
    return useSWR<RecommendedResponse>(
        taskType ? `/api/v1/models/recommended/${taskType}` : null,
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 60_000 },
    )
}
