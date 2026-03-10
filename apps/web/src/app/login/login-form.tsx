// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Github, Mail, ArrowRight, Loader2, ExternalLink } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'

export function LoginForm() {
    const router = useRouter()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    async function handleCredentials(e: React.FormEvent) {
        e.preventDefault()
        setIsLoading(true)
        setError(null)

        const result = await signIn('credentials', {
            email,
            password,
            redirect: false,
        })

        if (result?.error) {
            setError('Invalid email or password')
            setIsLoading(false)
        } else {
            router.push('/')
            router.refresh()
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
            {/* Background pattern */}
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-azure/10 via-canvas to-canvas" />

            <div className="relative w-full max-w-sm">
                {/* Logo */}
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
                        <PlexoMark className="w-10 h-10 text-azure drop-shadow-lg" />
                    </div>
                    <h1 className="text-lg font-semibold tracking-tight">Sign in to Plexo</h1>
                    <p className="mt-1.5 text-sm text-text-muted">
                        Your AI agent is waiting
                    </p>
                </div>

                {/* Form card */}
                <div className="rounded-2xl border border-border bg-surface-1/50 p-6 shadow-xl backdrop-blur-sm">
                    <form onSubmit={handleCredentials} className="space-y-3">
                        <div>
                            <label htmlFor="login-email" className="mb-1 block text-xs font-medium text-text-secondary">
                                Email
                            </label>
                            <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                                <input
                                    id="login-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    className="w-full rounded-lg border border-border bg-canvas py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure/50 focus:outline-none focus:ring-1 focus:ring-azure/50"
                                    required
                                />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="login-password" className="mb-1 block text-xs font-medium text-text-secondary">
                                Password
                            </label>
                            <input
                                id="login-password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••••••"
                                className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure/50 focus:outline-none focus:ring-1 focus:ring-azure/50"
                                required
                                minLength={12}
                            />
                        </div>

                        {error && (
                            <div className="rounded-lg bg-red-950/50 px-3 py-2 text-xs text-red">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={isLoading}
                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-azure px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-azure/90 disabled:opacity-50"
                        >
                            {isLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <>
                                    Sign In
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </>
                            )}
                        </button>
                    </form>
                </div>

                {/* Register link */}
                <p className="mt-5 text-center text-xs text-text-muted">
                    Don&apos;t have an account?{' '}
                    <Link href="/register" className="text-azure hover:text-azure-600">
                        Create one
                    </Link>
                </p>
            </div>
        </div>
    )
}
