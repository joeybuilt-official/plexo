// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceId } from '@web/context/workspace'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@plexo/ui'

interface LinkedLesson {
    revisionId: string
    routineId: string
    version: number
    status: string
    rationale: string
}

interface OutcomeView {
    id: string
    ts: string
    trigger: string
    summary: string | null
    routineId: string | null
    routineName: string | null
    taskId: string | null
    taskType: string | null
    taskStatus: string | null
    automatedOutcome: string | null
    humanVerdict: string | null
    disagreement: boolean
    lessons: LinkedLesson[]
}

function automatedBadge(v: string | null) {
    if (v === 'complete') return <Badge variant="success">Completed</Badge>
    if (v === 'failed') return <Badge variant="error">Failed</Badge>
    return <Badge variant="default">{v ?? 'Pending'}</Badge>
}

function humanBadge(v: string | null) {
    if (v === 'accept') return <Badge variant="success">Accepted</Badge>
    if (v === 'reject') return <Badge variant="error">Rejected</Badge>
    return <Badge variant="default">Not reviewed</Badge>
}

export default function OutcomesPage() {
    const workspaceId = useWorkspaceId()
    const [items, setItems] = useState<OutcomeView[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/v1/outcomes?workspaceId=${workspaceId}`)
            const data = (await res.json()) as { items?: OutcomeView[] }
            setItems(data.items ?? [])
        } catch {
            setError('Could not load outcomes.')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => {
        void load()
    }, [load])

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl mx-auto w-full">
            <div>
                <h1 className="text-lg font-medium text-text-primary">Outcomes</h1>
                <p className="text-[12px] text-text-muted">
                    What Plexo did and how it turned out — its own assessment next to yours, with anything it learned.
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
                <p className="text-[12px] text-text-muted">No outcomes yet.</p>
            ) : (
                <div className="flex flex-col gap-3">
                    {items.map((o) => (
                        <Card key={o.id}>
                            <CardHeader>
                                <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                                    <span>{o.routineName ?? o.taskType ?? o.trigger}</span>
                                    {o.disagreement && <Badge variant="warning">Verdicts disagree</Badge>}
                                    <span className="text-text-muted font-normal text-[11px] ml-auto">
                                        {new Date(o.ts).toLocaleString()}
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3">
                                {o.summary && (
                                    <p className="text-[12px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                                        {o.summary}
                                    </p>
                                )}

                                <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] uppercase tracking-wider text-text-muted">Plexo&apos;s assessment</span>
                                        {automatedBadge(o.automatedOutcome)}
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] uppercase tracking-wider text-text-muted">Your verdict</span>
                                        {humanBadge(o.humanVerdict)}
                                    </div>
                                </div>

                                {o.lessons.length > 0 && (
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">
                                            What Plexo learned
                                        </p>
                                        <ul className="flex flex-col gap-1">
                                            {o.lessons.map((l) => (
                                                <li key={l.revisionId} className="text-[11px] text-text-muted flex items-start gap-2">
                                                    <span className="text-text-secondary">v{l.version}</span>
                                                    <span className="text-text-muted">· {l.status} ·</span>
                                                    <span className="break-words">{l.rationale}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    )
}
