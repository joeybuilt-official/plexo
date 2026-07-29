// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Suspense } from 'react'
import { ResetPasswordForm } from './reset-password-form'

export const metadata = { title: 'Reset password — Plexo' }

export default function ResetPasswordPage() {
    return (
        <Suspense>
            <ResetPasswordForm />
        </Suspense>
    )
}
