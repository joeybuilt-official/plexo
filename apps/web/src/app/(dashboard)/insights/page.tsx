// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')

interface MemorySummary {
    total: number
    hot: number
    active: number
    cold: number
    avgConfidence: number
}

export default function InsightsPage() {
    const [summary, setSummary] = useState<MemorySummary | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const wsId = localStorage.getItem('plexo_workspace_id') ?? ''
        if (!wsId) { setLoading(false); return }
        fetch(`${API_BASE}/api/v1/memory/entries?workspaceId=${wsId}&limit=1`)
            .then(r => r.ok ? r.json() : null)
            .then((data: { total?: number; tier_counts?: Record<string, number>; avg_confidence?: number } | null) => {
                if (data) {
                    setSummary({
                        total: data.total ?? 0,
                        hot: data.tier_counts?.hot ?? 0,
                        active: data.tier_counts?.active ?? 0,
                        cold: data.tier_counts?.cold ?? 0,
                        avgConfidence: data.avg_confidence ?? 1,
                    })
                }
            })
            .catch(() => { /* no-op */ })
            .finally(() => setLoading(false))
    }, [])

    return (
        <div className="p-6 max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                    <Brain className="h-6 w-6 text-azure" />
                    Workspace Memory
                </h1>
                <p className="text-sm text-text-muted mt-1">How Plexo thinks about your work</p>
            </div>

            {loading ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} className="rounded-lg border border-border bg-surface-1/40 p-3 animate-pulse h-16" />
                    ))}
                </div>
            ) : summary ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatCard label="Total entries" value={summary.total} />
                    <StatCard label="Hot" value={summary.hot} />
                    <StatCard label="Active" value={summary.active} />
                    <StatCard label="Avg confidence" value={`${Math.round(summary.avgConfidence * 100)}%`} />
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
