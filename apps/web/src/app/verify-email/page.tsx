// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Suspense } from 'react'
import { VerifyEmailClient } from './verify-email-client'

export const metadata = { title: 'Verify email — Plexo' }

export default function VerifyEmailPage() {
    return (
        <Suspense>
            <VerifyEmailClient />
        </Suspense>
    )
}
