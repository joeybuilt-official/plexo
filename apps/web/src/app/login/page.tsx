// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getAuth } from '@web/lib/auth'
import { LoginForm } from './login-form'

export default async function LoginPage() {
    // Redirect logged-in users to the dashboard
    try {
        const h = await headers()
        const session = await getAuth().api.getSession({ headers: h })
        if (session?.user) redirect('/app')
    } catch { /* no session — show login */ }

    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

    try {
        const res = await fetch(`${apiBase}/api/v1/auth/setup-status`, { cache: 'no-store' })
        if (res.ok) {
            const data = await res.json() as { needsSetup: boolean }
            if (data.needsSetup) {
                redirect('/register')
            }
        }
    } catch {
        // assume properly configured if api unroutable or dead at start
    }

    return (
        <Suspense>
            <LoginForm />
        </Suspense>
    )
}
