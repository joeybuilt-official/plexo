// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 8 — Escalation inbox.
 *
 * Lists pending per-invocation tool-call escalations for the active
 * workspace, with approve/reject controls and a free-form note field.
 * Live-updates via the SSE stream at `/api/v1/escalations/stream`.
 */
'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldAlert, Check, X, Clock, RefreshCw } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

interface EscalationRow {
    id: string
    workspaceId: string
    sessionId: string
    agentId: string | null
    toolName: string
    payload: unknown
    reason: string | null
    status: 'pending' | 'approved' | 'rejected' | 'timeout'
    requestedAt: string
    decidedAt: string | null
    decidedBy: string | null
    expiresAt: string
    decisionNote: string | null
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

function timeUntil(iso: string): string {
    const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000)
    if (s <= 0) return 'expired'
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function EscalationsPage() {
    const { workspaceId } = useWorkspace()
    const [rows, setRows] = useState<EscalationRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [notes, setNotes] = useState<Record<string, string>>({})
    const [busyId, setBusyId] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`/api/v1/escalations?workspaceId=${workspaceId}&status=pending`, {
                cache: 'no-store',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: EscalationRow[] }
            setRows(data.items ?? [])
            setError(null)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Live updates via SSE — any requested/decided event triggers a refresh.
    useEffect(() => {
        if (!workspaceId) return
        const es = new EventSource(`/api/v1/escalations/stream?workspaceId=${workspaceId}`)
        const onReq = () => { void refresh() }
        const onDec = () => { void refresh() }
        es.addEventListener('escalation_requested', onReq)
        es.addEventListener('escalation_decided', onDec)
        es.onerror = () => {
            // browser will auto-retry; nothing to do
        }
        return () => {
            es.removeEventListener('escalation_requested', onReq)
            es.removeEventListener('escalation_decided', onDec)
            es.close()
        }
    }, [workspaceId, refresh])

    const decide = useCallback(async (id: string, verdict: 'approve' | 'reject') => {
        setBusyId(id)
        try {
            const res = await fetch(`/api/v1/escalations/${id}/${verdict}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: notes[id] ?? '' }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setRows((prev) => prev.filter((r) => r.id !== id))
            setNotes((prev) => {
                const next = { ...prev }
                delete next[id]
                return next
            })
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }, [notes])

    const content = useMemo(() => {
        if (loading && rows.length === 0) {
            return (
                <div className="flex items-center gap-2 text-text-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading escalations...
                </div>
            )
        }
        if (rows.length === 0) {
            return (
                <div className="rounded-md border border-border bg-surface-1 p-8 text-center text-text-muted">
                    No pending escalations. Agents are running unsupervised.
                </div>
            )
        }
        return (
            <div className="space-y-4">
                {rows.map((row) => (
                    <article
                        key={row.id}
                        className="rounded-md border border-border bg-surface-1 p-4"
                    >
                        <header className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3">
                                <ShieldAlert className="mt-0.5 h-5 w-5 text-text-primary" />
                                <div>
                                    <h3 className="text-base font-medium text-text-primary">
                                        {row.toolName}
                                    </h3>
                                    <p className="text-sm text-text-muted">
                                        {row.reason ?? 'escalation requested'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-text-muted">
                                <Clock className="h-3 w-3" />
                                <span>expires in {timeUntil(row.expiresAt)}</span>
                            </div>
                        </header>

                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
                            <div>
                                <dt className="inline font-medium text-text-primary">Agent </dt>
                                <dd className="inline">{row.agentId ?? 'primary'}</dd>
                            </div>
                            <div>
                                <dt className="inline font-medium text-text-primary">Session </dt>
                                <dd className="inline font-mono">{row.sessionId.slice(0, 8)}</dd>
                            </div>
                            <div>
                                <dt className="inline font-medium text-text-primary">Requested </dt>
                                <dd className="inline">{timeAgo(row.requestedAt)}</dd>
                            </div>
                        </dl>

                        <pre className="mt-3 max-h-48 overflow-auto rounded border border-border bg-surface-1 p-2 text-xs text-text-primary">
                            {JSON.stringify(row.payload, null, 2)}
                        </pre>

                        <div className="mt-3 flex items-end gap-2">
                            <label className="flex-1">
                                <span className="block text-xs text-text-muted">Note (optional)</span>
                                <input
                                    type="text"
                                    className="mt-1 w-full rounded border border-border bg-surface-1 px-2 py-1.5 text-sm text-text-primary focus-ring"
                                    value={notes[row.id] ?? ''}
                                    onChange={(e) => setNotes((prev) => ({ ...prev, [row.id]: e.target.value }))}
                                    placeholder="Why approving or rejecting?"
                                />
                            </label>
                            <button
                                type="button"
                                disabled={busyId === row.id}
                                onClick={() => void decide(row.id, 'approve')}
                                className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-3 py-1.5 text-sm text-text-primary hover:opacity-90 disabled:opacity-50"
                            >
                                <Check className="h-4 w-4" /> Approve
                            </button>
                            <button
                                type="button"
                                disabled={busyId === row.id}
                                onClick={() => void decide(row.id, 'reject')}
                                className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-3 py-1.5 text-sm text-text-primary hover:opacity-90 disabled:opacity-50"
                            >
                                <X className="h-4 w-4" /> Reject
                            </button>
                        </div>
                    </article>
                ))}
            </div>
        )
    }, [rows, loading, notes, busyId, decide])

    return (
        <div className="mx-auto max-w-3xl p-6">
            <header className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-medium text-text-primary">Escalations</h1>
                    <p className="text-sm text-text-muted">
                        Per-invocation approvals for risky agent tool calls.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-3 py-1.5 text-sm text-text-primary hover:opacity-90"
                >
                    <RefreshCw className="h-4 w-4" /> Refresh
                </button>
            </header>
            {error ? (
                <div className="mb-4 rounded border border-border bg-surface-1 p-3 text-sm text-text-primary">
                    Error: {error}
                </div>
            ) : null}
            {content}
        </div>
    )
}
