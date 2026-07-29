// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceId } from '@web/context/workspace'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@plexo/ui'

interface SourceOutcome {
    id: string
    summary: string | null
    automatedOutcome: string | null
    humanVerdict: string | null
}

interface RevisionView {
    id: string
    routineId: string
    routineName: string
    version: number
    proposedDiff: string
    rationale: string
    sourceOutcomes: SourceOutcome[]
}

export default function RevisionsReviewPage() {
    const workspaceId = useWorkspaceId()
    const [items, setItems] = useState<RevisionView[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/v1/revisions/pending?workspaceId=${workspaceId}`)
            const data = (await res.json()) as { items?: RevisionView[] }
            setItems(data.items ?? [])
        } catch {
            setError('Could not load updates to review.')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => {
        void load()
    }, [load])

    // POSTs to the SAME canonical seam Telegram uses (/revisions/:id/decision).
    const decide = async (id: string, choice: 'approve' | 'reject') => {
        setBusy(id)
        setError(null)
        try {
            const res = await fetch(`/api/v1/revisions/${id}/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ choice }),
            })
            if (res.ok) {
                setItems((prev) => prev.filter((r) => r.id !== id))
            } else {
                const d = (await res.json().catch(() => ({}))) as { error?: string }
                setError(d?.error ?? (res.status === 409 ? 'This update is no longer valid — it may have changed.' : 'Could not save your decision.'))
            }
        } catch {
            setError('Could not save your decision.')
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl mx-auto w-full">
            <div>
                <h1 className="text-lg font-medium text-text-primary">Routine updates to review</h1>
                <p className="text-[12px] text-text-muted">
                    Plexo suggests changes to how a routine works, learned from recent results. Approve to apply, or reject.
                </p>
            </div>

            {error && (
                <p role="alert" className="text-[12px] text-red-400 border border-red-900/40 bg-red-dim rounded-sm p-2">
                    {error}
                </p>
            )}

            {loading ? (
                <p className="text-[12px] text-text-muted">Loading…</p>
            ) : items.length === 0 ? (
                <p className="text-[12px] text-text-muted">Nothing to review right now.</p>
            ) : (
                <div className="flex flex-col gap-3">
                    {items.map((rev) => (
                        <Card key={rev.id}>
                            <CardHeader>
                                <CardTitle className="text-sm">
                                    {rev.routineName} <span className="text-text-muted font-normal">· v{rev.version}</span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3">
                                <div>
                                    <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Why</p>
                                    <p className="text-[12px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">{rev.rationale}</p>
                                </div>

                                <div>
                                    <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Proposed change</p>
                                    <pre className="text-[11px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words bg-canvas border border-border rounded-sm p-2 max-h-72 overflow-y-auto">
                                        {rev.proposedDiff}
                                    </pre>
                                </div>

                                {rev.sourceOutcomes.length > 0 && (
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">
                                            Based on {rev.sourceOutcomes.length} recent result{rev.sourceOutcomes.length === 1 ? '' : 's'}
                                        </p>
                                        <ul className="flex flex-col gap-1">
                                            {rev.sourceOutcomes.map((o) => (
                                                <li key={o.id} className="text-[11px] text-text-muted flex items-start gap-2">
                                                    <span
                                                        className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${o.automatedOutcome === 'failed' ? 'bg-red-400' : 'bg-emerald-400'}`}
                                                        aria-hidden="true"
                                                    />
                                                    <span className="truncate">{o.summary ?? '(no summary)'}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                <div className="flex items-center gap-2 pt-1">
                                    <Button size="sm" disabled={busy === rev.id} onClick={() => decide(rev.id, 'approve')}>
                                        Approve
                                    </Button>
                                    <Button size="sm" variant="secondary" disabled={busy === rev.id} onClick={() => decide(rev.id, 'reject')}>
                                        Reject
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    )
}
