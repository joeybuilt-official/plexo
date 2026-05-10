// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getAuth } from '@web/lib/auth'
import { RegisterForm } from './register-form'

export default async function RegisterPage() {
    // Redirect logged-in users to the dashboard
    try {
        const h = await headers()
        const session = await getAuth().api.getSession({ headers: h })
        if (session?.user) redirect('/app')
    } catch { /* no session — show register */ }
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    let isFirstRun = false

    try {
        const res = await fetch(`${apiBase}/api/v1/auth/setup-status`, { cache: 'no-store' })
        if (res.ok) {
            const data = await res.json() as { needsSetup: boolean }
            isFirstRun = data.needsSetup
        }
    } catch {
        // Assume not first run if api is unreachable
    }

    return <RegisterForm isFirstRun={isFirstRun} />
}
