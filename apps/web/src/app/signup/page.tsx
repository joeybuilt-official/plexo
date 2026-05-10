// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getAuth } from '@web/lib/auth'
import { RegisterForm } from '../register/register-form'

/**
 * Public signup page.
 *
 * Uses Better Auth email + password.  On success the server sets the
 * session cookie and the client redirects to `/app`, which will
 * auto-create a Personal workspace if none exists for this user.
 */
export default async function SignupPage() {
    try {
        const h = await headers()
        const session = await getAuth().api.getSession({ headers: h })
        if (session?.user) redirect('/app')
    } catch { /* no session — show signup */ }

    return <RegisterForm isFirstRun={false} />
}
