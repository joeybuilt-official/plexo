// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

/* ---------- SCL types — supports both GoldenRecord v1.0 and legacy MindsetObject v0.2 ---------- */

interface MindsetRegion {
    id: string
    /** GoldenRecord v1.0 field */
    label?: string
    /** Legacy v0.2 field */
    name?: string
    /** Legacy v0.2 field */
    taskCount?: number
    density?: number
    centroid?: number[]
    radius?: number
    children: string[]
    namespace?: string
    // Legacy v0.2 fields (optional)
    avgQuality?: number
    topTools?: string[]
    topTaskTypes?: string[]
}

interface ConceptAttractor {
    id: string
    /** GoldenRecord v1.0 field */
    regionId?: string
    /** Legacy v0.2 field */
    region?: string
    type: string
    label: string
    salience: number
    depthClass?: string
    driftProtected?: boolean
    position?: number[]
    mutationCount?: number
    lastMutatedAt?: number
    namespace?: string
    attributes?: Record<string, unknown>
    // Legacy v0.2 field
    frequency?: number
}

interface TransformationRule {
    id?: string
    /** GoldenRecord v1.0 field */
    sourceRegionId?: string
    /** GoldenRecord v1.0 field */
    targetRegionId?: string
    /** Legacy v0.2 field */
    sourceRegion?: string
    /** Legacy v0.2 field */
    targetRegion?: string
    relationType: string
    confidence: number
    transform?: number[]
    modality?: string
    depthClass?: string
    // Legacy v0.2 field
    sharedTools?: string[]
}

export interface MindsetObject {
    version?: string
    id?: string
    workspaceId: string
    regions: MindsetRegion[]
    attractors: ConceptAttractor[]
    transformations: TransformationRule[]
    ledgerRefs?: unknown[]
    confidence?: number
    taskCount?: number
    createdAt?: string
    updatedAt?: string
    bootedAt?: number
    lastMutatedAt?: number
}

/* ---------- Helpers: normalize field access across v0.2 and v1.0 ---------- */

function regionLabel(r: MindsetRegion): string {
    return r.label ?? r.name ?? '(unnamed)'
}

function attractorRegionId(a: ConceptAttractor): string {
    return a.regionId ?? a.region ?? ''
}

function transformSource(t: TransformationRule): string {
    return t.sourceRegionId ?? t.sourceRegion ?? ''
}

function transformTarget(t: TransformationRule): string {
    return t.targetRegionId ?? t.targetRegion ?? ''
}

/* ---------- Palette: one hue per region ---------- */

const REGION_HUES: Record<string, number> = {
    code: 210,
    writing: 30,
    'data-analysis': 270,
    planning: 150,
    research: 330,
    qa: 60,
    conversation: 180,
    creative: 300,
}

function regionHue(label: string): number {
    return REGION_HUES[label] ?? ((label ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360)
}

function regionColor(label: string, l = 55): string {
    return `hsl(${regionHue(label)}, 60%, ${l}%)`
}

/* ---------- Simple force simulation (no D3 dep) ---------- */

interface FNode {
    id: string
    x: number
    y: number
    vx: number
    vy: number
    radius: number
    region: string
    label: string
    salience: number
    kind: 'region' | 'attractor'
}

interface FEdge {
    source: string
    target: string
    confidence: number
}

function buildGraph(m: MindsetObject): { nodes: FNode[]; edges: FEdge[] } {
    const nodes: FNode[] = []
    const edges: FEdge[] = []

    if (!m?.regions?.length) return { nodes, edges }

    // Build a lookup from region id → label for coloring attractor nodes
    const regionLabelById = new Map(m.regions.map(r => [r.id, regionLabel(r)]))

    // Region nodes — larger
    for (const r of m.regions) {
        const lbl = regionLabel(r)
        nodes.push({
            id: `r:${r.id}`,
            x: Math.random() * 800 - 400,
            y: Math.random() * 800 - 400,
            vx: 0, vy: 0,
            radius: 18 + Math.min(r.taskCount ?? Math.round(r.density ?? 5), 30),
            region: lbl,
            label: lbl,
            salience: 1,
            kind: 'region' as const,
        })
    }

    // Attractor nodes — smaller, linked to their region
    for (const a of m.attractors) {
        const rid = attractorRegionId(a)
        const rLabel = regionLabelById.get(rid) ?? rid
        nodes.push({
            id: `a:${a.id}`,
            x: Math.random() * 800 - 400,
            y: Math.random() * 800 - 400,
            vx: 0, vy: 0,
            radius: 4 + a.salience * 8,
            region: rLabel ?? '',
            label: a.label,
            salience: a.salience,
            kind: 'attractor' as const,
        })
        edges.push({ source: `a:${a.id}`, target: `r:${rid}`, confidence: a.salience })
    }

    // Transformation edges between regions
    for (const t of m.transformations) {
        edges.push({ source: `r:${transformSource(t)}`, target: `r:${transformTarget(t)}`, confidence: t.confidence })
    }

    return { nodes, edges }
}

function simulate(nodes: FNode[], edges: FEdge[], iterations: number) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const repulsion = 3000
    const attraction = 0.008
    const damping = 0.82
    const centerPull = 0.003

    for (let iter = 0; iter < iterations; iter++) {
        // Repulsion between all nodes
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j]
                let dx = b.x - a.x, dy = b.y - a.y
                const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
                const force = repulsion / (dist * dist)
                dx = (dx / dist) * force
                dy = (dy / dist) * force
                a.vx -= dx; a.vy -= dy
                b.vx += dx; b.vy += dy
            }
        }

        // Attraction along edges
        for (const e of edges) {
            const a = nodeMap.get(e.source), b = nodeMap.get(e.target)
            if (!a || !b) continue
            const dx = b.x - a.x, dy = b.y - a.y
            const force = attraction * e.confidence
            a.vx += dx * force; a.vy += dy * force
            b.vx -= dx * force; b.vy -= dy * force
        }

        // Center gravity — very light so nodes spread naturally
        for (const n of nodes) {
            n.vx -= n.x * centerPull
            n.vy -= n.y * centerPull
        }

        // Apply velocity
        for (const n of nodes) {
            n.vx *= damping; n.vy *= damping
            n.x += n.vx; n.y += n.vy
        }

        // Collision avoidance — prevent node overlap
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j]
                const dx = b.x - a.x, dy = b.y - a.y
                const dist = Math.sqrt(dx * dx + dy * dy) || 1
                const minDist = a.radius + b.radius + 20
                if (dist < minDist) {
                    const overlap = (minDist - dist) / 2
                    const nx = (dx / dist) * overlap
                    const ny = (dy / dist) * overlap
                    a.x -= nx; a.y -= ny
                    b.x += nx; b.y += ny
                }
            }
        }
    }
}

/* ---------- Force Graph View ---------- */

function ForceGraph({ mindset, activatedRegion, width, height }: {
    mindset: MindsetObject
    activatedRegion?: string
    width: number
    height: number
}) {
    const { nodes, edges } = useMemo(() => {
        const g = buildGraph(mindset)
        simulate(g.nodes, g.edges, 200)
        return g
    }, [mindset])

    const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

    // Fit to viewport
    const pad = 80
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y)
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad
    const vw = maxX - minX, vh = maxY - minY

    const [hover, setHover] = useState<string | null>(null)

    return (
        <svg
            viewBox={`${minX} ${minY} ${vw} ${vh}`}
            width={width}
            height={height}
            className="select-none"
            data-testid="mindset-graph"
        >
            {/* Edges */}
            {edges.map((e, i) => {
                const a = nodeMap.get(e.source), b = nodeMap.get(e.target)
                if (!a || !b) return null
                const isHovered = hover === e.source || hover === e.target
                return (
                    <line
                        key={i}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={isHovered ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.08)'}
                        strokeWidth={0.5 + e.confidence * 2}
                    />
                )
            })}

            {/* Nodes */}
            {nodes.map(n => {
                const isActive = activatedRegion && n.region === activatedRegion
                const isHovered = hover === n.id
                const col = regionColor(n.region, isActive ? 65 : 45)
                return (
                    <g
                        key={n.id}
                        onMouseEnter={() => setHover(n.id)}
                        onMouseLeave={() => setHover(null)}
                        className="cursor-pointer"
                    >
                        {/* Glow for activated region */}
                        {isActive && n.kind === 'region' && (
                            <circle cx={n.x} cy={n.y} r={n.radius + 6} fill="none"
                                stroke={regionColor(n.region, 70)} strokeWidth={2} opacity={0.5} />
                        )}
                        <circle
                            cx={n.x} cy={n.y} r={n.radius}
                            fill={col}
                            opacity={n.kind === 'region' ? 0.8 : 0.6}
                            stroke={isHovered ? '#fff' : 'none'}
                            strokeWidth={1.5}
                        />
                        {/* Label for regions, high-salience attractors, and hovered attractors */}
                        {(n.kind === 'region' || isHovered || n.salience >= 0.7) && (
                            <text
                                x={n.x} y={n.y + n.radius + 12}
                                textAnchor="middle"
                                fill="rgba(255,255,255,0.7)"
                                fontSize={n.kind === 'region' ? 11 : 9}
                                fontFamily="sans-serif"
                            >
                                {n.label}
                            </text>
                        )}
                        {/* Tooltip on hover */}
                        {isHovered && n.kind === 'attractor' && (
                            <text
                                x={n.x} y={n.y - n.radius - 6}
                                textAnchor="middle"
                                fill="rgba(255,255,255,0.5)"
                                fontSize={8}
                                fontFamily="sans-serif"
                            >
                                {n.salience.toFixed(2)} salience
                            </text>
                        )}
                    </g>
                )
            })}
        </svg>
    )
}

/* ---------- Sunburst View ---------- */

function Sunburst({ mindset, activatedRegion, width, height }: {
    mindset: MindsetObject
    activatedRegion?: string
    width: number
    height: number
}) {
    const cx = width / 2, cy = height / 2
    const outerR = Math.min(width, height) / 2 - 20
    const innerR = outerR * 0.35
    const midR = outerR * 0.65

    const regionSize = (r: MindsetRegion) => r.taskCount ?? Math.round(r.density ?? 1)
    const totalTasks = mindset.regions.reduce((s, r) => s + regionSize(r), 0) || 1

    // Build arcs — use reduce to avoid mutable variable during render
    const arcs = mindset.regions.reduce<Array<{ region: typeof mindset.regions[0]; start: number; end: number }>>((acc, r) => {
        const prev = acc.length > 0 ? acc[acc.length - 1]!.end : 0
        const sweep = (regionSize(r) / totalTasks) * Math.PI * 2
        acc.push({ region: r, start: prev, end: prev + sweep })
        return acc
    }, [])

    function describeArc(cx: number, cy: number, r1: number, r2: number, start: number, end: number): string {
        const gap = 0.01 // tiny gap between segments
        const s = start + gap, e = end - gap
        if (e <= s) return ''
        const largeArc = (e - s) > Math.PI ? 1 : 0
        const x1o = cx + r2 * Math.cos(s), y1o = cy + r2 * Math.sin(s)
        const x2o = cx + r2 * Math.cos(e), y2o = cy + r2 * Math.sin(e)
        const x1i = cx + r1 * Math.cos(e), y1i = cy + r1 * Math.sin(e)
        const x2i = cx + r1 * Math.cos(s), y2i = cy + r1 * Math.sin(s)
        return `M${x1o},${y1o} A${r2},${r2} 0 ${largeArc} 1 ${x2o},${y2o} L${x1i},${y1i} A${r1},${r1} 0 ${largeArc} 0 ${x2i},${y2i} Z`
    }

    const [hover, setHover] = useState<string | null>(null)

    return (
        <svg width={width} height={height} className="select-none" data-testid="mindset-graph">
            {/* Center label */}
            <text x={cx} y={cy - 6} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={10} fontFamily="sans-serif">
                workspace
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={12} fontFamily="sans-serif" fontWeight="600">
                {mindset.taskCount ?? mindset.attractors.length} items
            </text>

            {/* Region arcs (inner ring) */}
            {arcs.map(({ region: r, start, end }) => {
                const lbl = regionLabel(r)
                const isActive = activatedRegion === lbl || activatedRegion === r.id
                const isHovered = hover === r.id
                return (
                    <g key={r.id}
                        onMouseEnter={() => setHover(r.id)}
                        onMouseLeave={() => setHover(null)}
                        className="cursor-pointer"
                    >
                        <path
                            d={describeArc(cx, cy, innerR, midR, start, end)}
                            fill={regionColor(lbl, isActive ? 60 : isHovered ? 50 : 40)}
                            stroke="rgba(0,0,0,0.3)"
                            strokeWidth={1}
                        />
                        {/* Label in arc center */}
                        {(end - start) > 0.3 && (() => {
                            const midAngle = (start + end) / 2
                            const labelR = (innerR + midR) / 2
                            const lx = cx + labelR * Math.cos(midAngle)
                            const ly = cy + labelR * Math.sin(midAngle)
                            return (
                                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                                    fill="rgba(255,255,255,0.8)" fontSize={9} fontFamily="sans-serif">
                                    {lbl}
                                </text>
                            )
                        })()}
                    </g>
                )
            })}

            {/* Attractor arcs (outer ring) — subdivided within each region */}
            {arcs.map(({ region: r, start, end }) => {
                const lbl = regionLabel(r)
                const regionAttractors = mindset.attractors.filter(a => {
                    const rid = attractorRegionId(a)
                    return rid === r.id || rid === lbl
                })
                if (regionAttractors.length === 0) return null
                const totalSalience = regionAttractors.reduce((s, a) => s + a.salience, 0) || 1
                let aStart = start
                return regionAttractors.map(a => {
                    const sweep = (a.salience / totalSalience) * (end - start)
                    const arc = (
                        <path
                            key={a.id}
                            d={describeArc(cx, cy, midR + 2, outerR, aStart, aStart + sweep)}
                            fill={regionColor(lbl, 30 + a.salience * 30)}
                            stroke="rgba(0,0,0,0.2)"
                            strokeWidth={0.5}
                            onMouseEnter={() => setHover(a.id)}
                            onMouseLeave={() => setHover(null)}
                            className="cursor-pointer"
                        />
                    )
                    aStart += sweep
                    return arc
                })
            })}

            {/* Hover tooltip */}
            {hover && (() => {
                const region = mindset.regions.find(r => r.id === hover)
                const attractor = mindset.attractors.find(a => a.id === hover)
                const label = region ? `${regionLabel(region)} — ${region.taskCount ?? Math.round(region.density ?? 0)} tasks` :
                    attractor ? `${attractor.label} (${attractor.type}, ${attractor.salience.toFixed(2)})` : null
                if (!label) return null
                return (
                    <text x={cx} y={height - 8} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize={10} fontFamily="sans-serif">
                        {label}
                    </text>
                )
            })()}
        </svg>
    )
}

/* ---------- Main Component ---------- */

type ViewMode = 'graph' | 'sunburst'

interface MindsetObjectViewerProps {
    mindset: MindsetObject | null
    activatedRegion?: string
    className?: string
}

export function MindsetObjectViewer({ mindset, activatedRegion, className }: MindsetObjectViewerProps) {
    const [mode, setMode] = useState<ViewMode>('graph')
    const containerRef = useRef<HTMLDivElement>(null)
    const [dims, setDims] = useState({ w: 600, h: 500 })

    const measure = useCallback(() => {
        if (containerRef.current) {
            const r = containerRef.current.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) {
                setDims({ w: Math.round(r.width), h: Math.round(r.height) })
            }
        }
    }, [])

    useEffect(() => {
        measure()
        const ro = new ResizeObserver(measure)
        if (containerRef.current) ro.observe(containerRef.current)
        return () => ro.disconnect()
    }, [measure])

    if (!mindset || (mindset.regions.length === 0 && mindset.attractors.length === 0)) {
        return (
            <div className={`flex items-center justify-center text-sm text-text-muted ${className ?? ''}`}
                data-testid="mindset-graph">
                <div className="text-center space-y-1">
                    <p className="text-text-muted">No concept data yet.</p>
                    <p className="text-xs text-text-muted/60">Complete tasks to grow the mindset.</p>
                </div>
            </div>
        )
    }

    return (
        <div className={className ?? ''}>
            {/* View toggle */}
            <div className="flex items-center gap-2 mb-2">
                <button
                    onClick={() => setMode('graph')}
                    className={`focus-ring px-2 py-0.5 rounded text-xs transition-colors ${
                        mode === 'graph' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-primary'
                    }`}
                >
                    Graph
                </button>
                <button
                    onClick={() => setMode('sunburst')}
                    className={`focus-ring px-2 py-0.5 rounded text-xs transition-colors ${
                        mode === 'sunburst' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-primary'
                    }`}
                >
                    Sunburst
                </button>
            </div>

            <div ref={containerRef} className="w-full h-full min-h-[450px]">
                {mode === 'graph' ? (
                    <ForceGraph mindset={mindset} activatedRegion={activatedRegion} width={dims.w} height={dims.h} />
                ) : (
                    <Sunburst mindset={mindset} activatedRegion={activatedRegion} width={dims.w} height={dims.h} />
                )}
            </div>
        </div>
    )
}

export default MindsetObjectViewer
