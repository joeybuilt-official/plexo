// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Phase 1 embeddings UI.
 *
 * One thin module so the Settings → Intelligence → Embeddings page,
 * the local-server panel, and the re-embed modal all share the same
 * fetch surface and key-cache namespace.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

// ── Types ────────────────────────────────────────────────────────────────

export type EmbeddingHealth = 'healthy' | 'degraded' | 'broken' | 'unknown'

export interface EmbeddingProviderRow {
    instanceId: string
    providerType: string
    nickname: string
    managed: boolean
    supportsEmbeddings: boolean
    embeddingModels: string[]
    selectedModel: string | null
    dimensions: number | null
    embeddingPreferenceOrder: number | null
    lastUsedAt: string | null
    health: EmbeddingHealth
}

export interface LocalEmbeddingsHealth {
    installed: boolean
    status: 'not-detected' | 'starting' | 'healthy' | 'degraded' | 'unreachable' | string
    url: string | null
    model: string | null
    dimensions: number | null
    loadTimeMs?: number | null
    message?: string
}

export interface ReembedJob {
    jobId: string
    workspaceId: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    startedAt: string
    finishedAt?: string
    rowsScanned: number
    rowsReembedded: number
    rowsSkipped: number
    rowsErrored: number
    sclScanned: number
    sclReembedded: number
    sclSkipped: number
    sclErrored: number
    targetProvider: string
    targetModel: string
    targetDimensions: number
    lastCheckpoint?: string
    error?: string
}

// ── Hook keys ────────────────────────────────────────────────────────────

export function embeddingProvidersKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/embeddings/${workspaceId}/providers` : null
}

export function localHealthKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/embeddings/${workspaceId}/local/health` : null
}

export function reembedJobKey(workspaceId: string | null | undefined, jobId: string | null): string | null {
    if (!workspaceId || !jobId) return null
    return `/api/v1/embeddings/${workspaceId}/reembed/${jobId}`
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useEmbeddingProviders(workspaceId: string | null | undefined) {
    return useSWR<{ providers: EmbeddingProviderRow[] }>(
        embeddingProvidersKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useLocalEmbeddingsHealth(workspaceId: string | null | undefined) {
    return useSWR<LocalEmbeddingsHealth>(
        localHealthKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useReembedJob(workspaceId: string | null | undefined, jobId: string | null) {
    return useSWR<{ job: ReembedJob }>(
        reembedJobKey(workspaceId, jobId),
        jsonFetcher,
        { refreshInterval: jobId ? 2_000 : 0, revalidateOnFocus: true },
    )
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function patchEmbeddingModel(
    workspaceId: string,
    instanceId: string,
    body: { model: string; dimensions?: number },
): Promise<{
    ok: boolean
    instance: { instanceId: string; providerType: string; selectedModel: string | null; dimensions: number | null }
    dimensionChanged: boolean
    previousDimensions: number | null
}> {
    const res = await fetch(
        `/api/v1/embeddings/${workspaceId}/providers/${instanceId}/model`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
    )
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH model failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function startReembed(
    workspaceId: string,
    body: { sinceCreatedAt?: string; batchSize?: number; includeScl?: boolean } = {},
): Promise<{ ok: boolean; jobId: string; status: string }> {
    const res = await fetch(`/api/v1/embeddings/${workspaceId}/reembed`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Reembed start failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function reloadLocalEmbeddings(
    workspaceId: string,
    body: { model_dir?: string; model_name?: string } = {},
): Promise<{ ok: boolean; model?: string; dimensions?: number }> {
    const res = await fetch(`/api/v1/embeddings/${workspaceId}/local/reload`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Local reload failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}
