// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { NextRequest, NextResponse } from 'next/server'
import { getAuth } from '@web/lib/auth'
import { headers } from 'next/headers'

// Proxy to the Express API which has all AI SDK packages.
// The web app intentionally does not install AI SDK deps — that stays in packages/agent.

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

export async function POST(req: NextRequest): Promise<NextResponse> {
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) {
        return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    try {
        const body = await req.text()
        const upstream = await fetch(`${API_BASE}/api/v1/settings/ai-providers/test`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Service-Key': SERVICE_KEY,
                'X-Plexo-User-Id': session.user.id,
            },
            body,
            signal: AbortSignal.timeout(12_000),
        })
        const data = await upstream.json()
        return NextResponse.json(data, { status: upstream.status })
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ ok: false, message: msg }, { status: 502 })
    }
}
