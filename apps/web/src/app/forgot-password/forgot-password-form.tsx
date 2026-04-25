// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Mail, Loader2 } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { authClient } from '@web/lib/auth-client'

export function ForgotPasswordForm() {
    const [email, setEmail] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [submitted, setSubmitted] = useState(false)
    const [isLoading, setIsLoading] = useState(false)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setIsLoading(true)
        setError(null)

        try {
            const result = await authClient.requestPasswordReset({
                email,
                redirectTo: `${window.location.origin}/reset-password`,
            })
            if (result.error) {
                setError(result.error.message ?? 'Could not send reset email')
                setIsLoading(false)
                return
            }
            setSubmitted(true)
            setIsLoading(false)
        } catch {
            setError('Could not send reset email. Try again.')
            setIsLoading(false)
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
            <div className="relative w-full max-w-sm">
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
                        <PlexoMark className="h-10 w-10 text-text-primary" />
                    </div>
                    <h1 className="text-lg font-medium tracking-tight text-text-primary">Reset your password</h1>
                    <p className="mt-1.5 text-sm text-text-muted">
                        We&apos;ll email you a link to set a new one.
                    </p>
                    {!process.env.NEXT_PUBLIC_SMTP_CONFIGURED && (
                        <p className="mt-2 rounded-md border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
                            Password reset emails are not configured for this instance. Contact your administrator.
                        </p>
                    )}
                </div>

                <div className="rounded-md border border-border bg-surface-1 p-6">
                    {submitted ? (
                        <div className="space-y-3 text-sm text-text-primary">
                            <p>If an account exists for <span className="font-medium">{email}</span>, a reset link is on its way.</p>
                            <p className="text-xs text-text-muted">Check spam if you don&apos;t see it in a few minutes.</p>
                            <Link href="/login" className="inline-block text-xs text-text-primary hover:underline">
                                Back to sign in
                            </Link>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-3">
                            <div>
                                <label htmlFor="forgot-email" className="mb-1 block text-xs font-medium text-text-muted">
                                    Email
                                </label>
                                <div className="relative">
                                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                                    <input
                                        id="forgot-email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="you@example.com"
                                        className="w-full rounded-md border border-border bg-surface-1 py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/30 focus-ring focus:ring-1 focus:ring-accent/20"
                                        required
                                        autoComplete="email"
                                    />
                                </div>
                            </div>

                            {error && (
                                <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-text-primary px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:opacity-90 disabled:opacity-50"
                            >
                                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send reset link'}
                            </button>

                            <div className="pt-1 text-center">
                                <Link href="/login" className="text-xs text-text-muted hover:text-text-primary">
                                    Back to sign in
                                </Link>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    )
}
