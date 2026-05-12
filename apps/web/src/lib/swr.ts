// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR fetcher + typed hooks for the most-fetched client-side reads.
 *
 * Phase 8: replaces ad-hoc `useEffect` + `fetch` in pages so we get
 * deduplication, caching, and revalidation-on-focus for free.
 *
 * Revalidation policy matrix:
 *   - workspace    → on focus only (rarely changes)
 *   - tasks        → every 30s + on focus
 *   - conversations→ on focus
 *   - memory       → on focus
 *   - connections  → on focus
 *   - providers    → every 60s (model availability can shift)
 */

import useSWR, { type SWRConfiguration } from 'swr'

/** Fetcher that fails loudly on non-2xx so SWR `error` path triggers. */
export async function jsonFetcher<T>(url: string): Promise<T> {
    const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`) as Error & { status?: number }
        err.status = res.status
        throw err
    }
    return res.json() as Promise<T>
}

const DEFAULTS: SWRConfiguration = {
    fetcher: jsonFetcher,
    dedupingInterval: 30_000,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
}

// ——— Workspace ————————————————————————————————————————————————

export interface WorkspaceDetail {
    id: string
    name: string
    settings?: Record<string, unknown>
}

export function useWorkspaceDetail(workspaceId: string | null | undefined) {
    return useSWR<WorkspaceDetail>(
        workspaceId ? `/api/v1/workspaces/${workspaceId}` : null,
        { ...DEFAULTS, dedupingInterval: 60_000 },
    )
}

// ——— Tasks ————————————————————————————————————————————————————

export interface TaskRow {
    id: string
    title: string
    status: string
    createdAt: string
    updatedAt: string
    priority?: string
}

export function useTasks(workspaceId: string | null | undefined, opts?: { status?: string; limit?: number }) {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspaceId', workspaceId)
    if (opts?.status) params.set('status', opts.status)
    if (opts?.limit) params.set('limit', String(opts.limit))
    return useSWR<{ items: TaskRow[]; total?: number }>(
        workspaceId ? `/api/v1/tasks?${params.toString()}` : null,
        { ...DEFAULTS, refreshInterval: 30_000 },
    )
}

// ——— Conversations ————————————————————————————————————————————

export interface ConversationRow {
    id: string
    title: string | null
    channel: string
    updatedAt: string
    lastMessagePreview?: string | null
}

export function useConversations(workspaceId: string | null | undefined) {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspaceId', workspaceId)
    return useSWR<{ items: ConversationRow[] }>(
        workspaceId ? `/api/v1/conversations?${params.toString()}` : null,
        DEFAULTS,
    )
}

// ——— Memory ———————————————————————————————————————————————————

export interface MemoryEntry {
    id: string
    type: string
    content: string
    createdAt: string
    updatedAt: string
    metadata?: Record<string, unknown> | null
}

export function useMemoryEntries(workspaceId: string | null | undefined, opts?: { type?: string; limit?: number }) {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspaceId', workspaceId)
    if (opts?.type) params.set('type', opts.type)
    if (opts?.limit) params.set('limit', String(opts.limit))
    return useSWR<{ items: MemoryEntry[]; total?: number }>(
        workspaceId ? `/api/v1/memory/entries?${params.toString()}` : null,
        DEFAULTS,
    )
}

// ——— Connections —————————————————————————————————————————————

export interface ConnectionRow {
    name: string
    displayName?: string
    installed: boolean
    enabled?: boolean
    status?: string
    category?: string
}

export function useConnections(workspaceId: string | null | undefined) {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspaceId', workspaceId)
    return useSWR<{ items: ConnectionRow[] } | ConnectionRow[]>(
        workspaceId ? `/api/v1/connections?${params.toString()}` : null,
        DEFAULTS,
    )
}

// ——— AI providers / models ————————————————————————————————————

export interface ProviderInfo {
    id: string
    name: string
    available: boolean
    models?: Array<{ id: string; label?: string; context?: number }>
}

export function useProviders(workspaceId: string | null | undefined) {
    return useSWR<{ providers: ProviderInfo[] } | ProviderInfo[]>(
        workspaceId ? `/api/v1/workspaces/${workspaceId}/ai-providers` : null,
        { ...DEFAULTS, refreshInterval: 60_000 },
    )
}
