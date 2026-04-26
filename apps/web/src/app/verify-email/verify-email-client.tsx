// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'

type Phase = 'pending' | 'ok' | 'error'

/**
 * Better Auth issues an email-verification link of the shape
 *    /verify-email?token=<jwt>&callbackURL=/app
 * The server endpoint that actually consumes the token is
 *    GET /api/auth/verify-email?token=...&callbackURL=...
 * which sets the verification flag and redirects to the callback URL.
 *
 * So our job on this page is straightforward: proxy the token to the
 * Better Auth endpoint, then follow the redirect to /app.
 */
export function VerifyEmailClient() {
    const router = useRouter()
    const params = useSearchParams()
    const token = params?.get('token')
    const [phase, setPhase] = useState<Phase>('pending')
    const [message, setMessage] = useState<string>('Verifying your email…')

    useEffect(() => {
        let cancelled = false
        async function run() {
            if (!token) {
                setPhase('error')
                setMessage('Missing verification token.')
                return
            }
            try {
                const url = `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/app')}`
                const res = await fetch(url, { method: 'GET', credentials: 'include' })
                if (cancelled) return
                if (!res.ok && res.status !== 302 && res.status !== 0) {
                    setPhase('error')
                    setMessage('This verification link is invalid or has expired.')
                    return
                }
                setPhase('ok')
                setMessage('Email verified. Redirecting…')
                setTimeout(() => router.push('/app'), 800)
            } catch {
                if (cancelled) return
                setPhase('error')
                setMessage('Could not verify email. Try again.')
            }
        }
        run()
        return () => { cancelled = true }
    }, [token, router])

    return (
        <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4 py-10">
            <div className="relative w-full max-w-sm text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
                    <PlexoMark className="h-10 w-10 text-text-primary" />
                </div>
                <div className="rounded border border-border bg-surface-1 p-8">
                    <div className="mb-4 flex justify-center">
                        {phase === 'pending' && <Loader2 className="h-8 w-8 animate-spin text-text-muted" />}
                        {phase === 'ok' && <CheckCircle2 className="h-8 w-8 text-text-primary" />}
                        {phase === 'error' && <XCircle className="h-8 w-8 text-text-primary" />}
                    </div>
                    <p className="text-sm text-text-primary">{message}</p>
                    {phase === 'error' && (
                        <div className="mt-4">
                            <Link href="/login" className="text-xs text-text-muted hover:text-text-primary">
                                Back to sign in
                            </Link>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
