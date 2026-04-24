// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Snapshot } from './types'
import { API } from './types'

export default function HistoryTab({ workspaceId }: { workspaceId: string }) {
    const [snapshots, setSnapshots] = useState<Snapshot[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Snapshot | null>(null)

    useEffect(() => {
        if (!workspaceId) return
        void (async () => {
            const res = await fetch(`${API}/api/v1/behavior/${workspaceId}/snapshots?limit=20`)
            if (res.ok) setSnapshots((await res.json() as { snapshots: Snapshot[] }).snapshots)
            setLoading(false)
        })()
    }, [workspaceId])

    if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>

    return (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">
                Snapshots capture the compiled system prompt at each task start or manual preview. Click a snapshot to inspect its prompt.
            </p>
            {snapshots.length === 0 ? (
                <p className="text-sm text-text-muted italic py-4">No snapshots yet. They&apos;re created each time the agent starts a task.</p>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {snapshots.map(s => (
                        <div key={s.id}
                            className={`rounded-lg border px-4 py-3 cursor-pointer transition-colors ${selected?.id === s.id ? 'border-azure/40 bg-azure/10' : 'border-border hover:border-border'}`}
                            onClick={() => setSelected(selected?.id === s.id ? null : s)}>
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-text-secondary capitalize">{s.triggeredBy.replace('_', ' ')}</span>
                                <span className="text-[11px] text-text-muted">{new Date(s.createdAt).toLocaleString()}</span>
                            </div>
                            {s.triggerResourceId && <p className="text-[11px] text-text-muted font-mono mt-0.5">{s.triggerResourceId.slice(0, 8)}</p>}
                            {selected?.id === s.id && s.compiledPrompt && (
                                <pre className="mt-3 text-[11px] text-text-muted bg-canvas rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap border border-border">
                                    {s.compiledPrompt}
                                </pre>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
