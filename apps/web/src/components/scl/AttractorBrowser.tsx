// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Shield, Zap, ChevronDown, ChevronRight, Search } from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface Attractor {
    id: string
    label: string
    regionId: string
    type: string
    depthClass: 'spirit' | 'mechanics'
    salience: number
    mutationCount: number
    driftProtected: boolean
    lastMutatedAt: number
}

interface Region {
    id: string
    label: string
    density: number
}

interface GoldenRecordData {
    regions: Region[]
    attractors: Attractor[]
}

export function AttractorBrowser({ workspaceId }: { workspaceId: string }) {
    const [data, setData] = useState<GoldenRecordData | null>(null)
    const [loading, setLoading] = useState(true)
    const [expandedRegion, setExpandedRegion] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [depthFilter, setDepthFilter] = useState<'all' | 'spirit' | 'mechanics'>('all')

    const fetchData = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl-admin/mindset/${workspaceId}`)
            if (!res.ok) return
            const raw = await res.json()
            // Try Golden Record format first, fall back to mindset
            const gr = raw.goldenRecord ?? raw
            if (gr?.regions && gr?.attractors) {
                setData({ regions: gr.regions, attractors: gr.attractors })
            }
        } catch { /* non-fatal */ } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchData() }, [fetchData])

    if (loading) {
        return <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading attractors...</div>
    }

    if (!data || data.attractors.length === 0) {
        return <p className="text-sm text-text-muted py-4">No attractors yet. Complete tasks to build the knowledge lattice.</p>
    }

    const filtered = data.attractors.filter(a => {
        if (depthFilter !== 'all' && a.depthClass !== depthFilter) return false
        if (search && !a.label.toLowerCase().includes(search.toLowerCase())) return false
        return true
    })

    const byRegion = new Map<string, Attractor[]>()
    for (const a of filtered) {
        const list = byRegion.get(a.regionId) ?? []
        list.push(a)
        byRegion.set(a.regionId, list)
    }

    const regionMap = new Map(data.regions.map(r => [r.id, r]))

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-text-primary">Attractors</h3>
                <span className="text-[11px] text-text-muted">{filtered.length} / {data.attractors.length}</span>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-text-muted" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Filter attractors..."
                        className="w-full rounded-lg border border-border bg-surface-1 pl-7 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                    />
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-border bg-canvas p-0.5">
                    {(['all', 'spirit', 'mechanics'] as const).map(v => (
                        <button
                            key={v}
                            onClick={() => setDepthFilter(v)}
                            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                                depthFilter === v
                                    ? 'bg-surface-2 text-text-primary shadow-sm'
                                    : 'text-text-muted hover:text-text-secondary'
                            }`}
                        >
                            {v === 'all' ? 'All' : v === 'spirit' ? 'Spirit' : 'Mechanics'}
                        </button>
                    ))}
                </div>
            </div>

            {/* Region groups */}
            <div className="space-y-2">
                {Array.from(byRegion.entries())
                    .sort((a, b) => b[1].length - a[1].length)
                    .map(([regionId, attractors]) => {
                        const region = regionMap.get(regionId)
                        const expanded = expandedRegion === regionId
                        return (
                            <div key={regionId} className="rounded-xl border border-border/60 bg-surface-1/40 overflow-hidden">
                                <button
                                    onClick={() => setExpandedRegion(expanded ? null : regionId)}
                                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-1/60 transition-colors"
                                >
                                    {expanded ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 text-text-muted" />}
                                    <span className="text-xs font-medium text-text-primary">{region?.label ?? regionId}</span>
                                    <span className="text-[11px] text-text-muted ml-auto">{attractors.length} attractor{attractors.length !== 1 ? 's' : ''}</span>
                                </button>
                                {expanded && (
                                    <div className="border-t border-border px-3 py-2 space-y-1">
                                        {attractors
                                            .sort((a, b) => b.salience - a.salience)
                                            .map(a => (
                                                <div key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2/40 transition-colors">
                                                    {a.depthClass === 'spirit'
                                                        ? <Shield className="h-3 w-3 text-purple-400 shrink-0" />
                                                        : <Zap className="h-3 w-3 text-azure shrink-0" />
                                                    }
                                                    <span className="text-xs text-text-primary flex-1 truncate">{a.label}</span>
                                                    <span className="text-[11px] text-text-muted shrink-0">{a.type}</span>
                                                    <div className="w-12 h-1.5 rounded-full bg-surface-2 shrink-0 overflow-hidden" title={`Salience: ${(a.salience * 100).toFixed(0)}%`}>
                                                        <div className={`h-full rounded-full ${a.depthClass === 'spirit' ? 'bg-purple-400' : 'bg-azure'}`}
                                                            style={{ width: `${Math.max(5, a.salience * 100)}%` }} />
                                                    </div>
                                                    <span className="text-[11px] text-text-muted shrink-0 w-8 text-right">×{a.mutationCount}</span>
                                                </div>
                                            ))
                                        }
                                    </div>
                                )}
                            </div>
                        )
                    })
                }
            </div>
        </div>
    )
}
