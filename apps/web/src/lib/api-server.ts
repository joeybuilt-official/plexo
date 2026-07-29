// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Server-only API client.
 *
 * Used from server components, route handlers, and middleware to call the
 * Plexo API with the currently signed-in user's identity. The browser
 * already carries its auth cookie directly to the API via the Next.js
 * rewrite in `next.config.ts`, but server-side fetches happen on the
 * container network and need a trusted bypass instead.
 *
 * Auth strategy:
 *   - Read the Better Auth session from the incoming request cookies
 *     (via `next/headers`) to resolve the user id.
 *   - Forward `X-Plexo-Service-Key` (shared secret) + `X-Plexo-User-Id`
 *     to the API so the API middleware can attach `req.user` without
 *     re-validating the cookie.
 *
 * If there is no session cookie, the request is sent without identity
 * headers — the API will respond 401 (or the caller can anticipate it).
 */

import { headers } from 'next/headers'
import { getAuth } from './auth'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

interface ApiFetchOptions extends RequestInit {
    /** Skip the session lookup (for truly public endpoints like /health). */
    anonymous?: boolean
}

async function resolveUserId(): Promise<string | null> {
    try {
        const h = await headers()
        const auth = getAuth()
        const session = await auth.api.getSession({ headers: h })
        const id = session?.user?.id
        return typeof id === 'string' ? id : null
    } catch {
        return null
    }
}

/**
 * Fetch against the Plexo API from a server component / route handler.
 * Accepts a path (e.g. `/api/v1/tasks?workspaceId=...`) or a full URL.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`

    const headersOut = new Headers(options.headers)

    if (!options.anonymous) {
        const userId = await resolveUserId()
        const serviceKey = process.env.PLEXO_SERVICE_KEY
        if (userId && serviceKey) {
            headersOut.set('X-Plexo-Service-Key', serviceKey)
            headersOut.set('X-Plexo-User-Id', userId)
        }
    }

    const { anonymous: _anonymous, ...rest } = options
    return fetch(url, { ...rest, headers: headersOut })
}

/**
 * Convenience: fetch and parse JSON, returning null on non-OK responses.
 */
export async function apiFetchJson<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T | null> {
    try {
        const res = await apiFetch(path, options)
        if (!res.ok) return null
        return (await res.json()) as T
    } catch {
        return null
    }
}
