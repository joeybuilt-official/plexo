'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Github, Mail, ArrowRight, Loader2, ExternalLink } from 'lucide-react'

interface LoginFormProps {
    githubConfigured: boolean
}

export function LoginForm({ githubConfigured }: LoginFormProps) {
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
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
            {/* Background pattern */}
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-zinc-950 to-zinc-950" />

            <div className="relative w-full max-w-sm">
                {/* Logo */}
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-bold text-white shadow-lg shadow-indigo-500/25">
                        P
                    </div>
                    <h1 className="text-lg font-semibold tracking-tight">Sign in to Plexo</h1>
                    <p className="mt-1.5 text-sm text-zinc-500">
                        Your AI agent is waiting
                    </p>
                </div>

                {/* Form card */}
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur-sm">
                    {/* GitHub OAuth */}
                    {githubConfigured ? (
                        <button
                            id="github-signin-btn"
                            onClick={() => signIn('github', { callbackUrl: '/' })}
                            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
                        >
                            <Github className="h-4 w-4" />
                            Continue with GitHub
                        </button>
                    ) : (
                        <a
                            id="github-setup-link"
                            href="/setup/github"
                            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-400"
                        >
                            <Github className="h-4 w-4" />
                            Continue with GitHub
                            <ExternalLink className="ml-auto h-3 w-3" />
                        </a>
                    )}

                    {/* Divider */}
                    <div className="my-5 flex items-center gap-3">
                        <div className="h-px flex-1 bg-zinc-800" />
                        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                            or
                        </span>
                        <div className="h-px flex-1 bg-zinc-800" />
                    </div>

                    {/* Email/Password */}
                    <form onSubmit={handleCredentials} className="space-y-3">
                        <div>
                            <label htmlFor="login-email" className="mb-1 block text-xs font-medium text-zinc-400">
                                Email
                            </label>
                            <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
                                <input
                                    id="login-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2.5 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                                    required
                                />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="login-password" className="mb-1 block text-xs font-medium text-zinc-400">
                                Password
                            </label>
                            <input
                                id="login-password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••••••"
                                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                                required
                                minLength={12}
                            />
                        </div>

                        {error && (
                            <div className="rounded-lg bg-red-950/50 px-3 py-2 text-xs text-red-400">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={isLoading}
                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
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
                <p className="mt-5 text-center text-xs text-zinc-600">
                    Don&apos;t have an account?{' '}
                    <a href="/register" className="text-indigo-400 hover:text-indigo-300">
                        Create one
                    </a>
                </p>
            </div>
        </div>
    )
}
