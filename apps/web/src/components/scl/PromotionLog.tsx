// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowUp, RefreshCw, Shield, Zap } from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface Attractor {
    id: string
    label: string
    depthClass: 'spirit' | 'mechanics'
    mutationCount: number
    lastMutatedAt: number
}

interface LedgerRef {
    externalRef: string
    ghostLabel: string
    archivedAt: number
    displacedBy?: string
}

function timeAgo(ts: number) {
    if (!ts) return '—'
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

export function PromotionLog({ workspaceId }: { workspaceId: string }) {
    const [promotions, setPromotions] = useState<Attractor[]>([])
    const [ghosts, setGhosts] = useState<LedgerRef[]>([])
    const [loading, setLoading] = useState(true)

    const fetchData = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl-admin/mindset/${workspaceId}`)
            if (!res.ok) return
            const raw = await res.json()
            const gr = raw.goldenRecord ?? raw
            if (gr?.attractors) {
                // Spirit attractors sorted by mutation count = promotion candidates / recent promotions
                const spirits = (gr.attractors as Attractor[])
                    .filter((a: Attractor) => a.depthClass === 'spirit')
                    .sort((a: Attractor, b: Attractor) => b.lastMutatedAt - a.lastMutatedAt)
                setPromotions(spirits)
            }
            if (gr?.ledgerRefs) {
                setGhosts((gr.ledgerRefs as LedgerRef[]).sort((a: LedgerRef, b: LedgerRef) => b.archivedAt - a.archivedAt))
            }
        } catch { /* non-fatal */ } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchData() }, [fetchData])

    if (loading) {
        return <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading...</div>
    }

    if (promotions.length === 0 && ghosts.length === 0) {
        return <p className="text-sm text-text-muted py-4">No promotions or archived concepts yet.</p>
    }

    return (
        <div className="space-y-4">
            {/* Spirit promotions */}
            {promotions.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <ArrowUp className="h-3.5 w-3.5 text-purple-400" />
                        <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wider">Spirit Anchors</h4>
                        <span className="text-[11px] text-text-muted">{promotions.length}</span>
                    </div>
                    <div className="space-y-1">
                        {promotions.slice(0, 20).map(a => (
                            <div key={a.id} className="flex items-center gap-2 rounded border border-purple-800/20 bg-purple-900/10 px-3 py-2">
                                <Shield className="h-3 w-3 text-purple-400 shrink-0" />
                                <span className="text-xs text-text-primary flex-1 truncate">{a.label}</span>
                                <span className="text-[11px] text-text-muted shrink-0">×{a.mutationCount}</span>
                                <span className="text-[11px] text-text-muted shrink-0">{timeAgo(a.lastMutatedAt)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Archived ghosts */}
            {ghosts.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Zap className="h-3.5 w-3.5 text-text-muted" />
                        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Archived (Ghosts)</h4>
                        <span className="text-[11px] text-text-muted">{ghosts.length}</span>
                    </div>
                    <div className="space-y-1">
                        {ghosts.slice(0, 10).map(g => (
                            <div key={g.externalRef} className="flex items-center gap-2 rounded border border-border/40 bg-surface-1/20 px-3 py-2 opacity-60">
                                <span className="text-xs text-text-muted flex-1 truncate line-through">{g.ghostLabel}</span>
                                {g.displacedBy && <span className="text-[11px] text-azure">→ {g.displacedBy}</span>}
                                <span className="text-[11px] text-text-muted shrink-0">{timeAgo(g.archivedAt)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
