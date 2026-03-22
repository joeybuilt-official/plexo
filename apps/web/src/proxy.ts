// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export default async function middleware(request: NextRequest) {
    return updateSession(request)
}

export const config = {
    matcher: ['/((?!api|_next/static|_next/image|favicon.ico|login|register|setup|invite).*)'],
}
