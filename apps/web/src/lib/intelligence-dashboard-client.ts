// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Phase 5 visibility dashboard.
 * Talks to /api/v1/intel-dashboard/:workspaceId/*.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

// ── Flow ─────────────────────────────────────────────────────────────────

export interface FlowProvider {
    id: string
    providerType: string
    nickname: string | null
    enabled: boolean
    managed: boolean
    selectedModel: string | null
    embeddingModel: string | null
    embeddingDimensions: number | null
}

export interface FlowResponse {
    providers: FlowProvider[]
    chains: Array<{ taskType: string; length: number }>
    embeddings: { configured: number; totalEnabled: number }
    scl: { enabled: boolean; driftThreshold: number }
    memory: { evictionEnabled: boolean }
    inferenceMode: string
}

export function useFlow(workspaceId: string | null | undefined) {
    return useSWR<FlowResponse>(
        workspaceId ? `/api/v1/intel-dashboard/${workspaceId}/flow` : null,
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )
}

// ── Health ───────────────────────────────────────────────────────────────

export interface ServiceHealth {
    name: string
    status: 'up' | 'down' | 'unknown'
    latencyMs: number | null
    detail: string | null
}

export interface HealthResponse {
    services: ServiceHealth[]
    checkedAt: string
}

export function useHealth(workspaceId: string | null | undefined) {
    return useSWR<HealthResponse>(
        workspaceId ? `/api/v1/intel-dashboard/${workspaceId}/health` : null,
        jsonFetcher,
        { refreshInterval: 20_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )
}

// ── Logs ─────────────────────────────────────────────────────────────────

export interface LogEntry {
    id: string
    model: string
    provider: string | null
    taskType: string
    inputTokens: number
    outputTokens: number
    latencyMs: number
    success: boolean
    costUsd: number
    priced: boolean
    createdAt: string
}

export interface LogsResponse {
    logs: LogEntry[]
    total: number
}

export interface LogsQuery {
    taskType?: string
    model?: string
    from?: string
    to?: string
    limit?: number
}

export function useLogs(workspaceId: string | null | undefined, query: LogsQuery = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        params.set(k, String(v))
    }
    const qs = params.toString()
    const key = workspaceId
        ? `/api/v1/intel-dashboard/${workspaceId}/logs${qs ? `?${qs}` : ''}`
        : null
    return useSWR<LogsResponse>(key, jsonFetcher, {
        refreshInterval: 0,
        revalidateOnFocus: false,
        dedupingInterval: 10_000,
    })
}

// ── Cost summary ─────────────────────────────────────────────────────────

export interface CostSummaryResponse {
    spend: {
        pricedUsd: number
        inputTokens: number
        outputTokens: number
        requests: number
        unpricedInputTokens: number
        unpricedOutputTokens: number
        monthStart: string
        computedAt: string
    }
    topModel: { model: string; costUsd: number; requests: number } | null
    topTaskType: { taskType: string; costUsd: number; requests: number } | null
}

export function useCostSummary(workspaceId: string | null | undefined) {
    return useSWR<CostSummaryResponse>(
        workspaceId ? `/api/v1/intel-dashboard/${workspaceId}/cost-summary` : null,
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

// ── Detect (Phase 6 — first-run wizard) ─────────────────────────────────

export interface DetectServiceProbe {
    name: string
    status: 'up' | 'down' | 'unknown'
    latencyMs: number | null
    detail: string | null
}

export interface DetectProvider {
    id: string
    providerType: string
    nickname: string | null
    enabled: boolean
    managed: boolean
    hasEmbeddingModel: boolean
    hasChatModel: boolean
}

export interface DetectResponse {
    services: {
        postgres: DetectServiceProbe
        pgvector: DetectServiceProbe
        embeddings: DetectServiceProbe
        ollama: DetectServiceProbe
    }
    providers: {
        total: number
        enabled: number
        withEmbedding: number
        withChat: number
        items: DetectProvider[]
    }
    current: {
        inferenceMode: string
        costCeilingUsd: number | null
        sclEnabled: boolean
        firstRunPending: boolean
    }
    recommendations: {
        embeddingsProvider: string | null
        inferenceMode: string
        sclEnabled: boolean
        costCeilingUsd: number
    }
}

export function useDetect(workspaceId: string | null | undefined) {
    return useSWR<DetectResponse>(
        workspaceId ? `/api/v1/intel-dashboard/${workspaceId}/detect` : null,
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 5_000 },
    )
}

export async function completeWizard(workspaceId: string): Promise<{ ok: true; firstRunPending: false }> {
    const res = await fetch(`/api/v1/intel-dashboard/${workspaceId}/wizard/complete`, {
        method: 'POST',
        credentials: 'include',
    })
    if (!res.ok) throw new Error(`completeWizard failed: HTTP ${res.status}`)
    return res.json()
}
