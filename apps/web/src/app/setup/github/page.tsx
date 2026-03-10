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
                <p className="text-sm text-text-secondary">
                    Navigate to{' '}
                    <a
                        href="https://github.com/settings/applications/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-azure"
                    >
                        github.com/settings/applications/new
                        <ExternalLink className="h-3 w-3" />
                    </a>{' '}
                    and fill in the form:
                </p>
                <div className="rounded-lg border border-border bg-canvas divide-y divide-zinc-800 text-sm">
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-text-muted">Application name</span>
                        <code className="text-text-primary">Plexo</code>
                    </div>
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-text-muted">Homepage URL</span>
                        <code className="text-text-primary">https://your-domain.com</code>
                    </div>
                    <div className="flex items-start gap-3 px-4 py-3">
                        <span className="w-44 shrink-0 text-text-muted">Callback URL</span>
                        <code className="text-text-primary">https://your-domain.com/api/auth/callback/github</code>
                    </div>
                </div>
                <p className="text-xs text-text-muted">
                    Replace <code className="text-text-secondary">your-domain.com</code> with the domain where Plexo is running.
                    For local development, use <code className="text-text-secondary">http://localhost:3000</code>.
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
                <p className="text-sm text-text-secondary">
                    On the app settings page, click <strong className="text-text-primary">Generate a new client secret</strong>.
                    Copy both the <strong className="text-text-primary">Client ID</strong> and the secret — the secret is only shown once.
                </p>
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3 text-xs text-amber">
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
                <p className="text-sm text-text-secondary">
                    Add these two variables to your <code className="text-text-secondary">.env</code> file:
                </p>
                <pre className="rounded-lg border border-border bg-canvas px-4 py-3 text-sm text-text-secondary overflow-x-auto">
                    <code>{`GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here`}</code>
                </pre>
                <p className="text-sm text-text-secondary">
                    Then restart your Plexo instance:
                </p>
                <pre className="rounded-lg border border-border bg-canvas px-4 py-3 text-sm text-text-secondary overflow-x-auto">
                    <code>{`docker compose up -d --no-deps web api`}</code>
                </pre>
            </div>
        ),
    },
]

export default function GithubSetupPage() {
    return (
        <div className="min-h-screen bg-canvas px-4 py-16">
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-azure/5 via-zinc-950 to-zinc-950" />

            <div className="relative mx-auto max-w-2xl">
                {/* Back */}
                <Link
                    href="/login"
                    className="mb-10 inline-flex items-center gap-2 text-sm text-text-muted transition-colors hover:text-text-secondary"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to sign in
                </Link>

                {/* Header */}
                <div className="mb-10">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface-2/50">
                        <Github className="h-6 w-6 text-text-secondary" />
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                        Set up GitHub login
                    </h1>
                    <p className="mt-2 text-sm text-text-muted">
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
                                className="rounded-2xl border border-border bg-surface-1/50 p-6"
                            >
                                <div className="mb-4 flex items-start gap-4">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-azure-dim border border-azure/20">
                                        <Icon className="h-4 w-4 text-azure" />
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                                            Step {step.number}
                                        </div>
                                        <h2 className="mt-0.5 text-base font-semibold text-text-primary">
                                            {step.title}
                                        </h2>
                                        <p className="mt-1 text-sm text-text-muted">
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
                <p className="mt-8 text-center text-xs text-text-muted">
                    After restarting, the &quot;Continue with GitHub&quot; button will be active on the sign-in page.{' '}
                    <a
                        href="https://github.com/joeybuilt-official/plexo"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-text-muted hover:text-text-secondary"
                    >
                        View docs on GitHub
                    </a>
                </p>
            </div>
        </div>
    )
}
