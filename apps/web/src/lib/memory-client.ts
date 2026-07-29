// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Phase 4 Memory UI.
 *
 * Talks to the existing memory router mounted at /api/v1/memory,
 * extended in Phase 4 with namespace + search + tier + eviction
 * endpoints. Same SWR namespace pattern as scl-client / intelligence-client.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

export type MemoryTier = 'hot' | 'active' | 'cold'
export type MemoryType = 'task' | 'incident' | 'session' | 'pattern'

export interface MemoryEntryView {
    id: string
    type: MemoryType | string
    content: string
    shorthand: string | null
    tier: MemoryTier | string
    namespace: string
    metadata: Record<string, unknown>
    created_at: string
    similarity?: number
}

export interface MemoryEntriesResponse {
    items: MemoryEntryView[]
    total: number
    mode?: 'list' | 'semantic' | 'text'
}

export interface NamespaceRow {
    namespace: string
    total: number
    hot: number
    active: number
    cold: number
}

export interface NamespacesResponse {
    namespaces: NamespaceRow[]
}

export interface EvictionSettings {
    enabled: boolean
    coldMaxAgeDays: number
    activeMaxAgeDays: number
}

export interface EvictionResponse {
    eviction: EvictionSettings
    defaults: EvictionSettings
    bounds: {
        coldMaxAgeDays: { min: number; max: number }
        activeMaxAgeDays: { min: number; max: number }
    }
}

export interface EntriesQuery {
    namespace?: string
    tier?: MemoryTier
    type?: MemoryType
    q?: string
    limit?: number
}

function entriesKey(workspaceId: string | null | undefined, query: EntriesQuery): string | null {
    if (!workspaceId) return null
    const params = new URLSearchParams({ workspaceId })
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        params.set(k, String(v))
    }
    return `/api/v1/memory/entries?${params.toString()}`
}

export function useMemoryEntries(
    workspaceId: string | null | undefined,
    query: EntriesQuery,
) {
    return useSWR<MemoryEntriesResponse>(
        entriesKey(workspaceId, query),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 10_000 },
    )
}

export function useMemoryNamespaces(workspaceId: string | null | undefined) {
    return useSWR<NamespacesResponse>(
        workspaceId ? `/api/v1/memory/namespaces?workspaceId=${workspaceId}` : null,
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: true, dedupingInterval: 30_000 },
    )
}

export function useEvictionSettings(workspaceId: string | null | undefined) {
    return useSWR<EvictionResponse>(
        workspaceId ? `/api/v1/memory/eviction?workspaceId=${workspaceId}` : null,
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export async function patchMemoryTier(
    workspaceId: string,
    id: string,
    tier: MemoryTier,
): Promise<{ ok: boolean; id: string; tier: MemoryTier }> {
    const res = await fetch(`/api/v1/memory/entries/${id}/tier`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, tier }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH tier failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function deleteMemoryEntry(
    workspaceId: string,
    id: string,
): Promise<{ ok: boolean }> {
    const res = await fetch(`/api/v1/memory/entries/${id}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
        credentials: 'include',
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`DELETE entry failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function patchEvictionSettings(
    workspaceId: string,
    body: Partial<EvictionSettings>,
): Promise<{ ok: boolean; eviction: EvictionSettings }> {
    const res = await fetch('/api/v1/memory/eviction', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...body }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH eviction failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}
