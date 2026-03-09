// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Github, ArrowLeft, ExternalLink, Terminal, Key, Globe } from 'lucide-react'
import Link from 'next/link'

export const metadata = {
    title: 'Set up GitHub login — Plexo',
    description: 'Configure GitHub OAuth to enable sign-in with GitHub on your self-hosted Plexo instance.',
}

const steps = [
    {
        number: '01',
        icon: Globe,
        title: 'Create a GitHub OAuth App',
        description: 'Register a new OAuth application in your GitHub account or organization.',
        content: (
            <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                    Navigate to{' '}
                    <a
                        href="https://github.com/settings/applications/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                    >
                        github.com/settings/applications/new
                        <ExternalLink className="h-3 w-3" />
                    </a>{' '}
                    and fill in the form:
                </p>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800 text-sm">
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-zinc-500">Application name</span>
                        <code className="text-zinc-200">Plexo</code>
                    </div>
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-zinc-500">Homepage URL</span>
                        <code className="text-zinc-200">https://your-domain.com</code>
                    </div>
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-zinc-500">Callback URL</span>
                        <code className="text-zinc-200">https://your-domain.com/api/auth/callback/github</code>
                    </div>
                </div>
                <p className="text-xs text-zinc-600">
                    Replace <code className="text-zinc-400">your-domain.com</code> with the domain where Plexo is running.
                    For local development, use <code className="text-zinc-400">http://localhost:3000</code>.
                </p>
            </div>
        ),
    },
    {
        number: '02',
        icon: Key,
        title: 'Generate a client secret',
        description: 'After registering the app, generate a client secret from the app settings page.',
        content: (
            <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                    On the app settings page, click <strong className="text-zinc-200">Generate a new client secret</strong>.
                    Copy both the <strong className="text-zinc-200">Client ID</strong> and the secret — the secret is only shown once.
                </p>
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-400">
                    Never commit your client secret to source control. Treat it like a password.
                </div>
            </div>
        ),
    },
    {
        number: '03',
        icon: Terminal,
        title: 'Add to your environment',
        description: 'Set the credentials in your .env file and restart.',
        content: (
            <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                    Add these two variables to your <code className="text-zinc-300">.env</code> file:
                </p>
                <pre className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-300 overflow-x-auto">
                    <code>{`GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here`}</code>
                </pre>
                <p className="text-sm text-zinc-400">
                    Then restart your Plexo instance:
                </p>
                <pre className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-300 overflow-x-auto">
                    <code>{`docker compose up -d --no-deps web api`}</code>
                </pre>
            </div>
        ),
    },
]

export default function GithubSetupPage() {
    return (
        <div className="min-h-screen bg-zinc-950 px-4 py-16">
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/10 via-zinc-950 to-zinc-950" />

            <div className="relative mx-auto max-w-2xl">
                {/* Back */}
                <Link
                    href="/login"
                    className="mb-10 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to sign in
                </Link>

                {/* Header */}
                <div className="mb-10">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-800/50">
                        <Github className="h-6 w-6 text-zinc-300" />
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                        Set up GitHub login
                    </h1>
                    <p className="mt-2 text-sm text-zinc-500">
                        GitHub login requires an OAuth app registered with your GitHub account.
                        This is a one-time setup that takes about two minutes.
                    </p>
                </div>

                {/* Steps */}
                <div className="space-y-6">
                    {steps.map((step) => {
                        const Icon = step.icon
                        return (
                            <div
                                key={step.number}
                                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6"
                            >
                                <div className="mb-4 flex items-start gap-4">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                                        <Icon className="h-4 w-4 text-indigo-400" />
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                                            Step {step.number}
                                        </div>
                                        <h2 className="mt-0.5 text-base font-semibold text-zinc-100">
                                            {step.title}
                                        </h2>
                                        <p className="mt-1 text-sm text-zinc-500">
                                            {step.description}
                                        </p>
                                    </div>
                                </div>
                                <div className="ml-[52px]">
                                    {step.content}
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Footer note */}
                <p className="mt-8 text-center text-xs text-zinc-600">
                    After restarting, the &quot;Continue with GitHub&quot; button will be active on the sign-in page.{' '}
                    <a
                        href="https://github.com/joeybuilt-official/plexo"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-500 hover:text-zinc-400"
                    >
                        View docs on GitHub
                    </a>
                </p>
            </div>
        </div>
    )
}
