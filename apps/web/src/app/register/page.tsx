// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { RegisterForm } from './register-form'
import { redirect } from 'next/navigation'

export default async function RegisterPage() {
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
