// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * GET /auth/handshake — Cross-app session establishment
 *
 * Previously accepted a JWT from a sibling Joeybuilt app.
 * Now that all apps share the same Better Auth schema, a valid Better Auth
 * session cookie is sufficient — if the browser is already signed in to
 * the shared auth DB, they are automatically signed in here too.
 *
 * If no active session is present, redirect to /login so the user can
 * authenticate via the Command Center's own login page.
 *
 * TODO: implement token-exchange for cross-app deep-link scenarios once
 * Command Center publishes a server-side handshake API.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuth } from '@web/lib/auth'

export const runtime = 'nodejs'

function sanitizeNext(next: string | null): string {
    if (!next) return '/app'
    if (next.startsWith('/') && !next.startsWith('//')) return next
    return '/app'
}

function resolveOrigin(req: NextRequest): string {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    if (host) return `${proto}://${host}`
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL
    return new URL(req.url).origin
}

export async function GET(req: NextRequest) {
    const origin = resolveOrigin(req)
    const { searchParams } = new URL(req.url)
    const safeNext = sanitizeNext(searchParams.get('next'))

    // Check for an existing Better Auth session.
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: req.headers })

    if (session?.user) {
        // Already authenticated — proceed to the requested destination.
        return NextResponse.redirect(new URL(safeNext, origin))
    }

    // No session — send to login, preserving the intended destination.
    const loginUrl = new URL('/login', origin)
    loginUrl.searchParams.set('next', safeNext)
    return NextResponse.redirect(loginUrl)
}
