// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * RSI proposals inbox — Phase 3b sub-page.
 *
 * Lists `rsi_proposals` rows for the current workspace. Each row shows
 * the anomaly type, hypothesis, risk badge, and proposed change JSON.
 * Approve transitions to `approved`; reject (labeled "Dismiss" in the
 * UI for clarity) transitions to `rejected`.
 *
 * The rsi_status enum has only pending/approved/rejected — no
 * `dismissed` value — so Phase 3b honors the additive constraint and
 * uses reject for both reject + dismiss intents.
 */

import { useState } from 'react'
import { Loader2, Check, X, Brain } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@web/context/workspace'
import {
    useRsiProposals,
    approveRsiProposal,
    rejectRsiProposal,
    type RsiStatus,
} from '@web/lib/scl-client'

const STATUS_TABS: Array<{ value: RsiStatus | 'all'; label: string }> = [
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All' },
]

const RISK_TONE: Record<string, string> = {
    low: 'border-emerald-700/40 text-emerald-300',
    medium: 'border-amber-700/40 text-amber-300',
    high: 'border-rose-700/40 text-rose-300',
}

export default function RsiInboxPage() {
    const { workspaceId } = useWorkspace()
    const [status, setStatus] = useState<RsiStatus | 'all'>('pending')
    const [pending, setPending] = useState<string | null>(null)
    const { data, mutate, isLoading, error } = useRsiProposals(workspaceId || null, status)

    async function handle(id: string, action: 'approve' | 'reject') {
        if (!workspaceId || pending) return
        setPending(id)
        try {
            if (action === 'approve') await approveRsiProposal(workspaceId, id)
            else await rejectRsiProposal(workspaceId, id)
            await mutate()
            toast.success(action === 'approve' ? 'Proposal approved' : 'Proposal rejected')
        } catch (err) {
            toast.error(err instanceof Error ? err.message : `${action} failed`)
        } finally {
            setPending(null)
        }
    }

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-sm bg-surface-1 flex items-center justify-center shrink-0">
                        <Brain className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-text-primary">RSI proposals</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Real-Time Self-Inspection anomalies that suggest a routing or config change. Approve to action; reject to dismiss.
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-2 border-b border-border p-3">
                {STATUS_TABS.map(tab => {
                    const count = data?.counts?.[tab.value === 'all' ? 'pending' : tab.value]
                    const active = status === tab.value
                    return (
                        <button
                            key={tab.value}
                            type="button"
                            onClick={() => setStatus(tab.value)}
                            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                active
                                    ? 'border-azure bg-surface-1 text-azure ring-1 ring-azure/40'
                                    : 'border-border bg-surface-1 text-text-muted hover:text-text-primary'
                            }`}
                        >
                            {tab.label}
                            {tab.value !== 'all' && count != null && (
                                <span className="ml-1 text-[10px] text-text-muted">·{count}</span>
                            )}
                        </button>
                    )
                })}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
                {!workspaceId ? (
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar.
                    </div>
                ) : isLoading ? (
                    <div className="flex items-center justify-center py-12 text-xs text-text-muted">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading RSI proposals…
                    </div>
                ) : error ? (
                    <div className="rounded-sm border border-rose-700/40 bg-surface-1 p-3 text-xs text-rose-300">
                        Failed to load proposals. {String(error)}
                    </div>
                ) : !data || data.proposals.length === 0 ? (
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        No {status === 'all' ? '' : status} proposals.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {data.proposals.map(p => {
                            const isPending = pending === p.id
                            const tone = RISK_TONE[p.risk] ?? 'border-border text-text-muted'
                            return (
                                <div key={p.id} className="rounded-sm border border-border bg-surface-1 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium text-text-primary truncate">
                                                    {p.anomalyType}
                                                </span>
                                                <span className={`inline-flex items-center rounded-sm border bg-surface-1 px-2 py-0.5 text-[10px] ${tone}`}>
                                                    {p.risk} risk
                                                </span>
                                            </div>
                                            <p className="mt-1 text-[12px] text-text-primary leading-snug">{p.hypothesis}</p>
                                            <div className="mt-1 text-[11px] text-text-muted">
                                                {new Date(p.createdAt).toLocaleString()}
                                            </div>
                                            {p.proposedChange && Object.keys(p.proposedChange).length > 0 && (
                                                <details className="mt-2">
                                                    <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text-primary">
                                                        Proposed change
                                                    </summary>
                                                    <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-surface-1 p-2 text-[10px] text-text-primary">
{JSON.stringify(p.proposedChange, null, 2)}
                                                    </pre>
                                                </details>
                                            )}
                                            {p.status !== 'pending' && (
                                                <div className="mt-1 text-[11px] text-text-muted">
                                                    {p.status} · {p.approvedAt ?? p.rejectedAt
                                                        ? new Date((p.approvedAt ?? p.rejectedAt) as string).toLocaleString()
                                                        : '—'}
                                                </div>
                                            )}
                                        </div>
                                        {p.status === 'pending' && (
                                            <div className="flex flex-shrink-0 flex-col gap-1">
                                                <button
                                                    type="button"
                                                    disabled={isPending}
                                                    onClick={() => void handle(p.id, 'approve')}
                                                    className="inline-flex items-center gap-1 rounded-md border border-emerald-700/40 bg-surface-1 px-2 py-1 text-[11px] text-emerald-300 hover:border-emerald-600 disabled:opacity-50"
                                                >
                                                    {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                                    Approve
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={isPending}
                                                    onClick={() => void handle(p.id, 'reject')}
                                                    className="inline-flex items-center gap-1 rounded-md border border-rose-700/40 bg-surface-1 px-2 py-1 text-[11px] text-rose-300 hover:border-rose-600 disabled:opacity-50"
                                                >
                                                    <X className="h-3 w-3" /> Dismiss
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </div>
    )
}
