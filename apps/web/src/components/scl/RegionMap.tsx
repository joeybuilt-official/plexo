// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Shield, Zap } from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface Region {
    id: string
    label: string
    density: number
    children: string[]
}

interface Attractor {
    id: string
    regionId: string
    depthClass: 'spirit' | 'mechanics'
    label: string
    salience: number
}

// Deterministic hue from region label
function regionHue(label: string): number {
    let hash = 0
    for (let i = 0; i < label.length; i++) hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
    return Math.abs(hash) % 360
}

export function RegionMap({ workspaceId }: { workspaceId: string }) {
    const [regions, setRegions] = useState<Region[]>([])
    const [attractors, setAttractors] = useState<Attractor[]>([])
    const [loading, setLoading] = useState(true)
    const [hovered, setHovered] = useState<string | null>(null)

    const fetchData = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl-admin/mindset/${workspaceId}`)
            if (!res.ok) return
            const raw = await res.json()
            const gr = raw.goldenRecord ?? raw
            if (gr?.regions) setRegions(gr.regions as Region[])
            if (gr?.attractors) setAttractors(gr.attractors as Attractor[])
        } catch { /* non-fatal */ } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchData() }, [fetchData])

    if (loading) {
        return <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading regions...</div>
    }

    if (regions.length === 0) {
        return <p className="text-sm text-text-muted py-4">No regions yet.</p>
    }

    // Build attractor counts per region
    const regionAttractors = new Map<string, { spirit: number; mechanics: number; total: number }>()
    for (const a of attractors) {
        const entry = regionAttractors.get(a.regionId) ?? { spirit: 0, mechanics: 0, total: 0 }
        entry.total++
        if (a.depthClass === 'spirit') entry.spirit++
        else entry.mechanics++
        regionAttractors.set(a.regionId, entry)
    }

    const maxTotal = Math.max(1, ...Array.from(regionAttractors.values()).map(v => v.total))

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-text-primary">Domain Regions</h3>
                <span className="text-[11px] text-text-muted">{regions.length} regions</span>
            </div>

            {/* Visual region bubbles */}
            <div className="flex flex-wrap gap-3 p-4 rounded-xl border border-border bg-canvas">
                {regions
                    .sort((a, b) => (regionAttractors.get(b.id)?.total ?? 0) - (regionAttractors.get(a.id)?.total ?? 0))
                    .map(region => {
                        const counts = regionAttractors.get(region.id) ?? { spirit: 0, mechanics: 0, total: 0 }
                        const hue = regionHue(region.label)
                        const size = 48 + Math.round((counts.total / maxTotal) * 64) // 48px-112px
                        const isHovered = hovered === region.id

                        return (
                            <div
                                key={region.id}
                                onMouseEnter={() => setHovered(region.id)}
                                onMouseLeave={() => setHovered(null)}
                                className="relative flex flex-col items-center justify-center rounded-2xl border transition-all cursor-default"
                                style={{
                                    width: size,
                                    height: size,
                                    borderColor: `hsl(${hue}, 50%, ${isHovered ? 60 : 30}%)`,
                                    backgroundColor: `hsl(${hue}, 40%, ${isHovered ? 15 : 8}%)`,
                                }}
                            >
                                <span className="text-[11px] font-medium text-text-primary text-center px-1 leading-tight truncate max-w-full">
                                    {region.label}
                                </span>
                                <span className="text-[10px] text-text-muted mt-0.5">
                                    {counts.total}
                                </span>

                                {/* Tooltip on hover */}
                                {isHovered && (
                                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 rounded-lg border border-border bg-surface-2 px-3 py-2 shadow-lg z-10 min-w-[140px]">
                                        <p className="text-xs font-medium text-text-primary mb-1">{region.label}</p>
                                        <div className="flex items-center gap-3 text-[11px] text-text-muted">
                                            <span className="flex items-center gap-1"><Shield className="h-2.5 w-2.5 text-purple-400" /> {counts.spirit}</span>
                                            <span className="flex items-center gap-1"><Zap className="h-2.5 w-2.5 text-azure" /> {counts.mechanics}</span>
                                        </div>
                                        {region.children.length > 0 && (
                                            <p className="text-[11px] text-text-muted mt-1">{region.children.length} sub-regions</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })
                }
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 text-[11px] text-text-muted">
                <span className="flex items-center gap-1"><Shield className="h-2.5 w-2.5 text-purple-400" /> Spirit (protected)</span>
                <span className="flex items-center gap-1"><Zap className="h-2.5 w-2.5 text-azure" /> Mechanics (learnable)</span>
                <span>Bubble size = attractor count</span>
            </div>
        </div>
    )
}
