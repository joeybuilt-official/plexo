// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, XCircle, Loader2, ShieldAlert } from 'lucide-react'

export interface InlineApprovalRecord {
    id: string
    operation: string
    description: string
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

const RISK_STYLES: Record<InlineApprovalRecord['riskLevel'], string> = {
    low: 'bg-surface-2/60 text-text-secondary',
    medium: 'bg-amber-500/15 text-amber-300',
    high: 'bg-amber-500/25 text-amber-200',
    critical: 'bg-red-500/25 text-red-300',
}

export function InlineApproval({ approval }: { approval: InlineApprovalRecord }) {
    const router = useRouter()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
    const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
    const [done, setDone] = useState<'approve' | 'reject' | null>(null)
    const [error, setError] = useState<string | null>(null)

    const headingId = `inline-approval-${approval.id}`
    const code = approval.id.slice(0, 6)

    async function decide(action: 'approve' | 'reject') {
        setBusy(action)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/api/v1/approvals/${approval.id}/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'web' }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
                throw new Error(body.error?.message ?? `Request failed (${res.status})`)
            }
            setDone(action)
            setTimeout(() => router.refresh(), 600)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setBusy(null)
        }
    }

    if (done === 'approve') {
        return (
            <section role="status" aria-live="polite" className="rounded-sm border border-azure-800/40 bg-azure/30 px-4 py-3 flex items-center gap-2 text-sm text-azure">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Approved — agent resuming…
            </section>
        )
    }
    if (done === 'reject') {
        return (
            <section role="status" aria-live="polite" className="rounded-sm border border-border/40 bg-surface-1/30 px-4 py-3 text-sm text-text-muted">
                Rejected.
            </section>
        )
    }

    return (
        <section
            role="region"
            aria-labelledby={headingId}
            className="rounded-sm border border-amber-900/40 bg-amber-dim/10 overflow-hidden"
        >
            <div className="flex items-start gap-3 border-b border-amber-900/30 px-4 py-3.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber/15 text-amber mt-0.5">
                    <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                        <h2 id={headingId} className="text-[13px] font-medium text-amber-300">
                            One-way door — approval required
                        </h2>
                        <span className={`rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wider ${RISK_STYLES[approval.riskLevel]}`}>
                            {approval.riskLevel}
                        </span>
                    </div>
                    <p className="mt-1 text-[12px] text-amber/80 leading-relaxed">
                        <span className="font-mono text-amber-200">{approval.operation}</span>
                        {' — '}
                        {approval.description}
                    </p>
                    <p className="mt-1.5 text-[11px] text-text-muted font-mono">
                        Code: <span className="text-text-secondary tracking-wider">{code}</span>
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 bg-surface-1/40">
                <button
                    type="button"
                    onClick={() => void decide('reject')}
                    disabled={busy !== null}
                    aria-label="Reject one-way-door"
                    className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-red-800/60 hover:text-red transition-colors disabled:opacity-40"
                >
                    {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                    Reject
                </button>
                <button
                    type="button"
                    onClick={() => void decide('approve')}
                    disabled={busy !== null}
                    aria-label="Approve one-way-door"
                    className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 transition-colors disabled:opacity-50"
                >
                    {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    Proceed
                </button>
            </div>

            {error && (
                <p role="alert" className="border-t border-amber-900/30 px-4 py-2 text-[11px] text-red bg-red-dim">
                    {error}
                </p>
            )}
        </section>
    )
}
