// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Brain, RefreshCw, Zap, Layers, Archive, Clock, Sparkles, Shield } from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface RecordMeta {
    enabled: boolean
    booted: boolean
    version: string
    regionCount: number
    attractorCount: number
    spiritCount: number
    mechanicsCount: number
    transformationCount: number
    ledgerRefCount: number
    lastMutatedAt: number
    bootedAt: number
}

function timeAgo(ts: number) {
    if (!ts) return 'Never'
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

export function GoldenRecordDashboard({ workspaceId }: { workspaceId: string }) {
    const [meta, setMeta] = useState<RecordMeta | null>(null)
    const [loading, setLoading] = useState(true)
    const [booting, setBooting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const fetchMeta = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl/record/meta?workspaceId=${workspaceId}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setMeta(await res.json() as RecordMeta)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchMeta() }, [fetchMeta])

    async function handleBoot() {
        setBooting(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl/boot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            await fetchMeta()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Boot failed')
        } finally {
            setBooting(false)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-4 text-sm text-text-muted">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading Golden Record...
            </div>
        )
    }

    if (error) {
        return (
            <div className="rounded border border-red-800/50 bg-red-dim px-4 py-3 text-xs text-red">
                Golden Record: {error}
            </div>
        )
    }

    if (!meta || !meta.booted) {
        return (
            <div className="rounded border border-border bg-surface-1 p-5 flex flex-col items-center gap-3">
                <Brain className="h-8 w-8 text-text-muted" />
                <p className="text-sm text-text-muted text-center">
                    Golden Record not initialized. Boot to create the semantic knowledge lattice.
                </p>
                <button
                    onClick={() => void handleBoot()}
                    disabled={booting}
                    className="btn-primary disabled:opacity-50"
                >
                    {booting ? (
                        <span className="flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Booting...</span>
                    ) : (
                        <span className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5" /> Boot Golden Record</span>
                    )}
                </button>
            </div>
        )
    }

    const spiritPct = meta.attractorCount > 0 ? Math.round((meta.spiritCount / meta.attractorCount) * 100) : 0

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Brain className="h-4 w-4 text-azure" />
                    <h3 className="text-sm font-semibold text-text-primary">Golden Record</h3>
                    <span className="text-[11px] font-mono text-text-muted">{meta.version}</span>
                </div>
                <button
                    onClick={() => void fetchMeta()}
                    className="p-1 text-text-muted hover:text-text-secondary transition-colors"
                    title="Refresh"
                    aria-label="Refresh"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard icon={Sparkles} label="Spirit" value={meta.spiritCount} accent="text-purple-400" />
                <StatCard icon={Zap} label="Mechanics" value={meta.mechanicsCount} accent="text-azure" />
                <StatCard icon={Layers} label="Regions" value={meta.regionCount} accent="text-amber" />
                <StatCard icon={Archive} label="Archived" value={meta.ledgerRefCount} accent="text-text-muted" />
            </div>

            {/* Spirit/Mechanics bar */}
            <div className="rounded border border-border bg-canvas p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span className="flex items-center gap-1"><Shield className="h-3 w-3 text-purple-400" /> Spirit {spiritPct}%</span>
                    <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-azure" /> Mechanics {100 - spiritPct}%</span>
                </div>
                <div className="flex h-2 rounded-full overflow-hidden bg-surface-2">
                    <div className="bg-purple-400 transition-all" style={{ width: `${spiritPct}%` }} />
                    <div className="bg-azure flex-1" />
                </div>
            </div>

            {/* Secondary stats */}
            <div className="flex flex-wrap gap-3 text-[11px] text-text-muted">
                <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    {meta.transformationCount} transformations
                </span>
                <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Booted {timeAgo(meta.bootedAt)}
                </span>
                <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Last mutated {timeAgo(meta.lastMutatedAt)}
                </span>
            </div>
        </div>
    )
}

function StatCard({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: number; accent: string }) {
    return (
        <div className="rounded border border-border bg-surface-1 p-3">
            <div className="flex items-center gap-1.5 mb-1">
                <Icon className={`h-3 w-3 ${accent}`} />
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">{label}</p>
            </div>
            <p className="text-lg font-semibold text-text-primary">{value}</p>
        </div>
    )
}
