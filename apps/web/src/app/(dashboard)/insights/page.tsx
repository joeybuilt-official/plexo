// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Brain, Download, RefreshCw } from 'lucide-react'
import { MindsetObjectViewer } from '@web/components/scl/MindsetObjectViewer'
import type { MindsetObject } from '@web/components/scl/MindsetObjectViewer'

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')

function exportMindsetJson(mindset: MindsetObject) {
    const blob = new Blob([JSON.stringify(mindset, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mindset-${mindset.workspaceId}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
}

export default function InsightsPage() {
    const [mindset, setMindset] = useState<MindsetObject | null>(null)
    const [loading, setLoading] = useState(true)
    const [wsId, setWsId] = useState('')

    useEffect(() => {
        const stored = localStorage.getItem('plexo_workspace_id') ?? ''
        setWsId(stored)
    }, [])

    const load = useCallback(async () => {
        if (!wsId) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl-admin/mindset/${wsId}`)
            if (res.ok) {
                const data = await res.json() as { mindset?: MindsetObject } | MindsetObject
                const resolved = ('mindset' in data ? data.mindset : data) as MindsetObject | undefined
                setMindset(resolved ?? null)
            }
        } catch {
            // no-op
        } finally {
            setLoading(false)
        }
    }, [wsId])

    useEffect(() => {
        void load()
    }, [load])

    const hasData = mindset && (mindset.regions.length > 0 || mindset.attractors.length > 0)

    return (
        <div className="p-6 max-w-5xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                        <Brain className="h-6 w-6 text-azure" />
                        Workspace Memory
                    </h1>
                    <p className="text-sm text-text-muted mt-1">How Plexo thinks about your work</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void load()}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                    </button>
                    {hasData && (
                        <button
                            onClick={() => exportMindsetJson(mindset!)}
                            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
                        >
                            <Download className="h-3.5 w-3.5" />
                            Export JSON
                        </button>
                    )}
                </div>
            </div>

            {/* Stats bar */}
            {hasData && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatCard label="Concepts" value={mindset!.attractors.length} />
                    <StatCard label="Domains" value={mindset!.regions.length} />
                    <StatCard label="Tasks analyzed" value={mindset!.taskCount ?? mindset!.attractors.length} />
                    <StatCard label="Confidence" value={`${Math.round((mindset!.confidence ?? 0) * 100)}%`} />
                </div>
            )}

            {/* Main graph */}
            {loading ? (
                <div className="h-96 rounded border border-border bg-surface-1/40 animate-pulse" />
            ) : hasData ? (
                <div className="rounded border border-border bg-surface-1/40 p-4">
                    <MindsetObjectViewer mindset={mindset!} className="h-96" />
                </div>
            ) : (
                <div
                    data-testid="memory-empty-state"
                    className="flex flex-col items-center justify-center rounded border border-dashed border-border bg-surface-1/20 p-16 text-center space-y-3"
                >
                    <Brain className="h-12 w-12 text-text-muted/40" />
                    <h3 className="text-base font-medium text-text-secondary">
                        Your workspace memory grows as you work
                    </h3>
                    <p className="text-sm text-text-muted max-w-sm">
                        Complete a few tasks and Plexo will start building a model of how you work,
                        what tools you use, and what patterns apply to your domain.
                    </p>
                </div>
            )}

            {/* Domain region cards */}
            {hasData && (
                <div>
                    <h2 className="text-sm font-medium text-text-secondary mb-3">Domain Regions</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {mindset!.regions.map(r => (
                            <div key={r.id} className="rounded-lg border border-border bg-surface-1/40 p-3 space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-text-primary capitalize">{r.label ?? r.name ?? '(unnamed)'}</span>
                                    <span className="text-xs text-text-muted">{r.taskCount ?? Math.round(r.density ?? 0)} items</span>
                                </div>
                                {(r.topTools?.length ?? 0) > 0 && (
                                    <p className="text-xs text-text-muted truncate">
                                        Tools: {r.topTools!.slice(0, 3).join(', ')}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

function StatCard({ label, value }: { label: string; value: number | string }) {
    return (
        <div className="rounded-lg border border-border bg-surface-1/40 p-3">
            <div className="text-xs text-text-muted">{label}</div>
            <div className="text-xl font-semibold text-text-primary mt-0.5">{value}</div>
        </div>
    )
}
