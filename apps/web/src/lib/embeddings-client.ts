// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Embeddings settings page — slimmed 2026-06-27
 * after the BYOK collapse. The page now surfaces only the bundled local
 * embeddings server (health probe + admin reload); per-workspace embedder
 * pick, BYO provider listing, and re-embed jobs were removed alongside
 * their API routes.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

// ── Types ────────────────────────────────────────────────────────────────

export interface LocalEmbeddingsHealth {
    installed: boolean
    status: 'not-detected' | 'starting' | 'healthy' | 'degraded' | 'unreachable' | string
    url: string | null
    model: string | null
    dimensions: number | null
    loadTimeMs?: number | null
    message?: string
}

// ── Hook keys ────────────────────────────────────────────────────────────

export function localHealthKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/embeddings/${workspaceId}/local/health` : null
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useLocalEmbeddingsHealth(workspaceId: string | null | undefined) {
    return useSWR<LocalEmbeddingsHealth>(
        localHealthKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

// ── Mutations ────────────────────────────────────────────────────────────

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
