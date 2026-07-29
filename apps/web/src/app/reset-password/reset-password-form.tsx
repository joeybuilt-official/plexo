// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { authClient } from '@web/lib/auth-client'

export function ResetPasswordForm() {
    const router = useRouter()
    const params = useSearchParams()
    const token = params?.get('token') ?? ''
    const errorFromQuery = params?.get('error')

    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const [isLoading, setIsLoading] = useState(false)

    useEffect(() => {
        if (errorFromQuery) setError('This reset link is invalid or has expired.')
    }, [errorFromQuery])

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setError(null)

        if (password.length < 12) {
            setError('Password must be at least 12 characters.')
            return
        }
        if (password !== confirm) {
            setError('Passwords do not match.')
            return
        }
        if (!token) {
            setError('Missing or invalid reset token.')
            return
        }

        setIsLoading(true)
        try {
            const result = await authClient.resetPassword({ newPassword: password, token })
            if (result.error) {
                setError(result.error.message ?? 'Could not reset password')
                setIsLoading(false)
                return
            }
            setSuccess(true)
            setIsLoading(false)
            setTimeout(() => router.push('/login'), 1200)
        } catch {
            setError('Could not reset password. Try again.')
            setIsLoading(false)
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4 py-10">
            <div className="relative w-full max-w-sm">
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
                        <PlexoMark className="h-10 w-10 text-text-primary" />
                    </div>
                    <h1 className="text-lg font-semibold tracking-tight text-text-primary">Set a new password</h1>
                    <p className="mt-1.5 text-sm text-text-muted">Pick something you won&apos;t forget.</p>
                </div>

                <div className="rounded border border-border bg-surface-1 p-6">
                    {success ? (
                        <div className="space-y-3 text-sm text-text-primary">
                            <p>Password updated. Redirecting to sign in…</p>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-3">
                            <div>
                                <label htmlFor="new-password" className="mb-1 block text-xs font-medium text-text-muted">
                                    New password
                                </label>
                                <input
                                    id="new-password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="Min 12 characters"
                                    className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                                    required
                                    minLength={12}
                                    autoComplete="new-password"
                                />
                            </div>
                            <div>
                                <label htmlFor="confirm-password" className="mb-1 block text-xs font-medium text-text-muted">
                                    Confirm password
                                </label>
                                <input
                                    id="confirm-password"
                                    type="password"
                                    value={confirm}
                                    onChange={(e) => setConfirm(e.target.value)}
                                    placeholder="Repeat new password"
                                    className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                                    required
                                    minLength={12}
                                    autoComplete="new-password"
                                />
                            </div>

                            {error && (
                                <div className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading || !token}
                                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-text-primary px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:opacity-90 disabled:opacity-50"
                            >
                                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
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
