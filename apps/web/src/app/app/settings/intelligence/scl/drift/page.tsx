// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Drift warning inbox — Phase 3b sub-page.
 *
 * Lists pending `scl_drift_warnings` rows for the current workspace.
 * Each row is a card with the attractor label, semantic distance, and
 * approve / reject buttons. Approve calls resolveDrift on the golden
 * record (via the API helper); reject leaves the centroid alone.
 *
 * Status filter is sticky local state — defaults to "pending" because
 * that's the actionable inbox view. "All" lets users see history.
 */

import { useState } from 'react'
import { Loader2, Check, X, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@web/context/workspace'
import {
    useDriftWarnings,
    approveDriftWarning,
    rejectDriftWarning,
    type DriftStatus,
} from '@web/lib/scl-client'

const STATUS_TABS: Array<{ value: DriftStatus | 'all'; label: string }> = [
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All' },
]

export default function DriftInboxPage() {
    const { workspaceId } = useWorkspace()
    const [status, setStatus] = useState<DriftStatus | 'all'>('pending')
    const [pending, setPending] = useState<string | null>(null)
    const { data, mutate, isLoading, error } = useDriftWarnings(workspaceId || null, status)

    async function handle(id: string, action: 'approve' | 'reject') {
        if (!workspaceId || pending) return
        setPending(id)
        try {
            if (action === 'approve') await approveDriftWarning(workspaceId, id)
            else await rejectDriftWarning(workspaceId, id)
            await mutate()
            toast.success(action === 'approve' ? 'Drift confirmed' : 'Drift rejected')
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
                    <div className="h-10 w-10 rounded-lg bg-surface-1 flex items-center justify-center shrink-0">
                        <AlertCircle className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-text-primary">Drift warnings</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Concept centroids that have shifted beyond the drift threshold. Approve to apply, reject to keep the existing centroid.
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
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar.
                    </div>
                ) : isLoading ? (
                    <div className="flex items-center justify-center py-12 text-xs text-text-muted">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading drift warnings…
                    </div>
                ) : error ? (
                    <div className="rounded-xl border border-rose-700/40 bg-surface-1 p-3 text-xs text-rose-300">
                        Failed to load drift warnings. {String(error)}
                    </div>
                ) : !data || data.warnings.length === 0 ? (
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        No {status === 'all' ? '' : status} drift warnings.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {data.warnings.map(w => {
                            const isPending = pending === w.id
                            return (
                                <div key={w.id} className="rounded-xl border border-border bg-surface-1 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium text-text-primary truncate">
                                                    {w.attractorLabel}
                                                </span>
                                                <span className="text-[11px] text-text-muted">{w.source}</span>
                                            </div>
                                            <div className="mt-1 text-[11px] text-text-muted">
                                                semantic distance{' '}
                                                <span className="text-text-primary tabular-nums">{w.semanticDistance.toFixed(3)}</span>
                                                {' '}· threshold{' '}
                                                <span className="text-text-primary tabular-nums">{w.threshold.toFixed(2)}</span>
                                                {' '}· {new Date(w.createdAt).toLocaleString()}
                                            </div>
                                            {w.status !== 'pending' && (
                                                <div className="mt-1 text-[11px] text-text-muted">
                                                    {w.status} · {w.resolvedAt ? new Date(w.resolvedAt).toLocaleString() : '—'}
                                                </div>
                                            )}
                                        </div>
                                        {w.status === 'pending' && (
                                            <div className="flex gap-1">
                                                <button
                                                    type="button"
                                                    disabled={isPending}
                                                    onClick={() => void handle(w.id, 'approve')}
                                                    className="inline-flex items-center gap-1 rounded-md border border-emerald-700/40 bg-surface-1 px-2 py-1 text-[11px] text-emerald-300 hover:border-emerald-600 disabled:opacity-50"
                                                >
                                                    {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                                    Approve
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={isPending}
                                                    onClick={() => void handle(w.id, 'reject')}
                                                    className="inline-flex items-center gap-1 rounded-md border border-rose-700/40 bg-surface-1 px-2 py-1 text-[11px] text-rose-300 hover:border-rose-600 disabled:opacity-50"
                                                >
                                                    <X className="h-3 w-3" /> Reject
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
