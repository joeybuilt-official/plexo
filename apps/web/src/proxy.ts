// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Next.js 16 proxy files always run in Node.js runtime.
// No runtime export or config export allowed — handle path filtering inline.

import { type NextRequest, NextResponse } from 'next/server'
import { getAuth } from './lib/auth'

export default async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl

    // Only /app/* routes require authentication — everything else passes through
    if (pathname.startsWith('/app')) {
        const auth = getAuth()
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) {
            const url = request.nextUrl.clone()
            url.pathname = '/login'
            url.searchParams.set('callbackUrl', request.url)
            return NextResponse.redirect(url)
        }
        return NextResponse.next({ request })
    }

    return NextResponse.next({ request })
}
