// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Mail, ArrowRight, Loader2, User } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { authClient } from '@web/lib/auth-client'

export function RegisterForm({ isFirstRun = false }: { isFirstRun?: boolean }) {
    const router = useRouter()
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [googleLoading, setGoogleLoading] = useState(false)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setIsLoading(true)
        setError(null)

        try {
            // Better Auth: creates the user in auth.user and — with
            // autoSignIn enabled server-side — sets the session cookie in
            // the same response. After success, push to /app which
            // auto-creates a Personal workspace when none exists.
            const result = await authClient.signUp.email({
                name: name || email.split('@')[0],
                email,
                password,
                callbackURL: '/app',
            })
            if (result.error) {
                setError(result.error.message ?? 'Registration failed')
                setIsLoading(false)
                return
            }
            router.push('/app')
            router.refresh()
        } catch {
            setError('Registration failed. Try again.')
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
                    <h1 className="text-lg font-medium tracking-tight text-text-primary">
                        {isFirstRun ? 'Setup your admin account' : 'Create your Plexo account'}
                    </h1>
                    <p className="mt-1.5 text-sm text-text-muted">
                        {isFirstRun
                            ? 'This is the first-run setup for this instance.'
                            : 'Run autonomous AI agents on your own terms.'}
                    </p>
                </div>

                <div className="rounded-md border border-border bg-surface-1 p-6">
                    {!isFirstRun && (
                        <>
                            <button
                                type="button"
                                disabled={googleLoading || isLoading}
                                onClick={async () => {
                                    setGoogleLoading(true)
                                    setError(null)
                                    try {
                                        await authClient.signIn.social({
                                            provider: 'google',
                                            callbackURL: '/app',
                                        })
                                    } catch {
                                        setError('Google sign-up failed. Try again.')
                                        setGoogleLoading(false)
                                    }
                                }}
                                className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-surface-1 px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-text-primary/5 disabled:opacity-50"
                            >
                                {googleLoading ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <>
                                        <svg className="h-4 w-4" viewBox="0 0 24 24">
                                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                        </svg>
                                        Continue with Google
                                    </>
                                )}
                            </button>

                            <div className="relative my-4">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border" />
                                </div>
                                <div className="relative flex justify-center text-xs">
                                    <span className="bg-surface-1 px-2 text-text-muted">or</span>
                                </div>
                            </div>
                        </>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-3">
                        <div>
                            <label htmlFor="register-name" className="mb-1 block text-xs font-medium text-text-muted">
                                Name
                            </label>
                            <div className="relative">
                                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                                <input
                                    id="register-name"
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Your name"
                                    className="w-full rounded-md border border-border bg-surface-1 py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/30 focus-ring focus:ring-1 focus:ring-accent/20"
                                    required
                                    autoComplete="name"
                                />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="register-email" className="mb-1 block text-xs font-medium text-text-muted">
                                Email
                            </label>
                            <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                                <input
                                    id="register-email"
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
                        <div>
                            <label htmlFor="register-password" className="mb-1 block text-xs font-medium text-text-muted">
                                Password
                            </label>
                            <input
                                id="register-password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Min 12 characters"
                                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/30 focus-ring focus:ring-1 focus:ring-accent/20"
                                required
                                minLength={12}
                                autoComplete="new-password"
                            />
                            <p className="mt-1 text-[11px] text-text-muted">Minimum 12 characters.</p>
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
                            {isLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <>
                                    Create Account
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </>
                            )}
                        </button>
                    </form>
                </div>

                <p className="mt-5 text-center text-xs text-text-muted">
                    Already have an account?{' '}
                    <Link href="/login" className="text-text-primary hover:underline">
                        Sign in
                    </Link>
                </p>
                <p className="mt-3 text-center text-[11px] text-text-muted/60">
                    By signing up, you agree to our{' '}
                    <Link href="/terms" className="underline hover:text-text-muted">Terms of Service</Link>
                    {' '}and{' '}
                    <Link href="/privacy" className="underline hover:text-text-muted">Privacy Policy</Link>.
                </p>
            </div>
        </div>
    )
}
