// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { createServerClient } from '@web/auth'
import { cookies } from 'next/headers'
import { cache } from 'react'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

/**
 * Resolve the primary workspace ID for the current session.
 *
 * Resolution order:
 * 1. Cookie 'plexo_workspace_id' (set by workspace picker, most reliable)
 * 2. Session user.id → fetch first workspace the user is a member of
 * 3. DEV_WORKSPACE_ID env var (local dev without auth)
 * 4. Returns null if none available
 *
 * React `cache()` dedups within a single server render pass.
 */
export const getWorkspaceId = cache(async (): Promise<string | null> => {
    // 1. Cookie — set by workspace picker, always authoritative when present
    try {
        const cookieStore = await cookies()
        const cookieId = cookieStore.get('plexo_workspace_id')?.value
        if (cookieId && cookieId.length > 10) return cookieId
    } catch {
        // cookies() not available outside server component — fall through
    }

    // 2. Session user → query workspaces they belong to
    try {
        const supabase = await createServerClient()
        const { data: { user } } = await supabase.auth.getUser()
        const userId = user?.id
        if (userId) {
            // Try member-based lookup first (covers both owner and member roles)
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces?userId=${encodeURIComponent(userId)}&limit=1`,
                { cache: 'no-store' },
            )
            if (res.ok) {
                const data = await res.json() as { items?: Array<{ id: string }>; workspaces?: Array<{ id: string }> }
                const items = data.items ?? data.workspaces ?? []
                if (items[0]?.id) return items[0].id
            }
            // Fallback: try ownerId query
            const ownerRes = await fetch(
                `${API_BASE}/api/v1/workspaces?ownerId=${encodeURIComponent(userId)}&limit=1`,
                { cache: 'no-store' },
            )
            if (ownerRes.ok) {
                const data = await ownerRes.json() as { items?: Array<{ id: string }>; workspaces?: Array<{ id: string }> }
                const items = data.items ?? data.workspaces ?? []
                if (items[0]?.id) return items[0].id
            }
        }
    } catch {
        // fall through to env fallback
    }

    // 3. Dev fallback
    return process.env.DEV_WORKSPACE_ID ?? process.env.DEFAULT_WORKSPACE_ID ?? null
})
