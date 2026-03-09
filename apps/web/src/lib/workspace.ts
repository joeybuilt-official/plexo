// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { auth } from '@web/auth'
import { cache } from 'react'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

/**
 * Resolve the primary workspace ID for the current session.
 *
 * Resolution order:
 * 1. Session user.id → fetch first workspace from /api/v1/workspaces?userId=...
 * 2. DEV_WORKSPACE_ID env var (local dev without auth)
 * 3. Returns null if neither is available
 *
 * React `cache()` dedups the fetch within a single server render pass.
 */
export const getWorkspaceId = cache(async (): Promise<string | null> => {
    // Try session first
    try {
        const session = await auth()
        const userId = session?.user?.id
        if (userId) {
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces?ownerId=${encodeURIComponent(userId)}&limit=1`,
                { cache: 'no-store' },
            )
            if (res.ok) {
                const data = await res.json() as { items?: Array<{ id: string }>; workspaces?: Array<{ id: string }> }
                const items = data.items ?? data.workspaces ?? []
                if (items[0]?.id) return items[0].id
            }
        }
    } catch {
        // fall through to env fallback
    }

    // Dev fallback
    return process.env.DEV_WORKSPACE_ID ?? process.env.DEFAULT_WORKSPACE_ID ?? null
})
