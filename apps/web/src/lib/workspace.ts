// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { getAuth } from '@web/lib/auth'
import { cookies, headers } from 'next/headers'
import { cache } from 'react'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

/**
 * Build internal SSR auth headers (service-key + user-id).
 * The API's requireAuth middleware trusts X-Plexo-Service-Key for server-to-server calls.
 */
function internalHeaders(userId: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(SERVICE_KEY ? {
            'X-Plexo-Service-Key': SERVICE_KEY,
            'X-Plexo-User-Id': userId,
        } : {}),
    }
}

/**
 * Build service-key auth headers for the /auth/workspace/ensure endpoint.
 * That endpoint uses requireServiceKey middleware which expects Authorization: Bearer + X-App-Id.
 */
function serviceKeyHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(SERVICE_KEY ? {
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'X-App-Id': 'plexo-web',
        } : {}),
    }
}

/**
 * Resolve the primary workspace ID for the current session.
 *
 * Resolution order:
 * 1. Cookie 'plexo_workspace_id' (set by workspace picker, most reliable)
 * 2. Session user.id → fetch first workspace the user is a member of
 * 3. No workspace found → idempotent get-or-create via /auth/workspace/ensure
 * 4. DEV_WORKSPACE_ID env var (local dev without auth)
 * 5. Returns null if none available
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
        const h = await headers()
        const auth = getAuth()
        const session = await auth.api.getSession({ headers: h })
        const userId = session?.user?.id
        if (userId) {
            const headers = internalHeaders(userId)

            // Fetch workspaces the user is a member of (authenticated via service key)
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces?limit=1`,
                { cache: 'no-store', headers },
            )
            if (res.ok) {
                const data = await res.json() as { items?: Array<{ id: string }> }
                if (data.items?.[0]?.id) return data.items[0].id
            }

            // 3. No workspace found — idempotent get-or-create via /ensure.
            // This endpoint checks for an existing workspace first and only
            // creates if none exists. Uses requireServiceKey auth (Bearer token
            // + X-App-Id) so it works reliably from SSR.
            const ensureRes = await fetch(`${API_BASE}/api/v1/auth/workspace/ensure`, {
                method: 'POST',
                headers: serviceKeyHeaders(),
                body: JSON.stringify({ userId, name: 'My Workspace' }),
            })
            if (ensureRes.ok) {
                const result = await ensureRes.json() as { workspaceId?: string }
                if (result.workspaceId) return result.workspaceId
            }
        }
    } catch {
        // fall through to env fallback
    }

    // 4. Dev fallback
    return process.env.DEV_WORKSPACE_ID ?? process.env.DEFAULT_WORKSPACE_ID ?? null
})
