// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, CreditCard, ArrowLeft, CheckCircle2 } from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface Subscription {
    tier: 'free' | 'pro' | 'team' | 'enterprise'
    status: 'active' | 'past_due' | 'canceled' | 'paused'
    currentPeriodEnd: string | null
    trialEndsAt: string | null
}

export function SubscriptionClient({ stripeProPriceId }: { stripeProPriceId: string | null }) {
    const [sub, setSub] = useState<Subscription>({ tier: 'free', status: 'active', currentPeriodEnd: null, trialEndsAt: null })
    const [loading, setLoading] = useState(true)
    const [upgrading, setUpgrading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const res = await fetch(`${API_BASE}/api/v1/billing/subscription`, { credentials: 'include' })
                if (res.ok) {
                    const data = (await res.json()) as { subscription?: Subscription }
                    if (!cancelled && data.subscription) setSub(data.subscription)
                }
                // If endpoint 404s or 500s we quietly fall back to `free`.
            } catch { /* fall back to free default */ }
            finally { if (!cancelled) setLoading(false) }
        }
        load()
        return () => { cancelled = true }
    }, [])

    async function handleUpgrade() {
        if (!stripeProPriceId) return
        setUpgrading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/billing/checkout`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priceId: stripeProPriceId }),
            })
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
                setError(data.error?.message ?? 'Could not start checkout')
                setUpgrading(false)
                return
            }
            const data = (await res.json()) as { url?: string }
            if (data.url) {
                window.location.href = data.url
            } else {
                setError('Checkout URL missing from response')
                setUpgrading(false)
            }
        } catch {
            setError('Could not start checkout. Try again.')
            setUpgrading(false)
        }
    }

    const tierLabel: Record<Subscription['tier'], string> = {
        free: 'Free',
        pro: 'Pro',
        team: 'Team',
        enterprise: 'Enterprise',
    }

    const statusLabel: Record<Subscription['status'], string> = {
        active: 'Active',
        past_due: 'Past due',
        canceled: 'Canceled',
        paused: 'Paused',
    }

    return (
        <div className="mx-auto w-full max-w-2xl space-y-6 p-4 sm:p-6">
            <header className="space-y-1">
                <Link href="/app/account" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary">
                    <ArrowLeft className="h-3 w-3" /> Back to account
                </Link>
                <h1 className="text-xl font-medium tracking-tight text-text-primary">Subscription</h1>
                <p className="text-sm text-text-muted">Your current plan and billing state.</p>
            </header>

            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <h2 className="mb-4 text-sm font-medium text-text-primary">Current plan</h2>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-text-muted">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <dl className="space-y-2 text-sm text-text-primary">
                        <div className="flex items-center justify-between">
                            <dt className="text-text-muted">Tier</dt>
                            <dd className="font-medium">{tierLabel[sub.tier]}</dd>
                        </div>
                        <div className="flex items-center justify-between">
                            <dt className="text-text-muted">Status</dt>
                            <dd className="font-medium">{statusLabel[sub.status]}</dd>
                        </div>
                        {sub.currentPeriodEnd && (
                            <div className="flex items-center justify-between">
                                <dt className="text-text-muted">Renews</dt>
                                <dd className="font-medium">{new Date(sub.currentPeriodEnd).toLocaleDateString()}</dd>
                            </div>
                        )}
                        {sub.trialEndsAt && (
                            <div className="flex items-center justify-between">
                                <dt className="text-text-muted">Trial ends</dt>
                                <dd className="font-medium">{new Date(sub.trialEndsAt).toLocaleDateString()}</dd>
                            </div>
                        )}
                    </dl>
                )}
            </section>

            {sub.tier === 'free' && (
                <section className="rounded-sm border border-border bg-surface-1 p-5">
                    <h2 className="mb-2 text-sm font-medium text-text-primary">Upgrade to Pro</h2>
                    <ul className="mb-4 space-y-1 text-xs text-text-muted">
                        <li className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3 w-3 text-text-primary" /> Unlimited workspaces</li>
                        <li className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3 w-3 text-text-primary" /> All channels and integrations</li>
                        <li className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3 w-3 text-text-primary" /> Priority support</li>
                    </ul>

                    {stripeProPriceId ? (
                        <button
                            type="button"
                            onClick={handleUpgrade}
                            disabled={upgrading}
                            className="flex items-center gap-1.5 rounded-sm border border-border bg-text-primary px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
                        >
                            {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
                            Upgrade to Pro
                        </button>
                    ) : (
                        <div className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs text-text-muted">
                            Pro coming soon.
                        </div>
                    )}

                    {error && (
                        <div className="mt-3 rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                            {error}
                        </div>
                    )}
                </section>
            )}

            {sub.tier !== 'free' && (
                <section className="rounded-sm border border-border bg-surface-1 p-5 text-xs text-text-muted">
                    Manage billing, invoices, and cancellation through the Stripe customer portal (coming soon).
                </section>
            )}
        </div>
    )
}
