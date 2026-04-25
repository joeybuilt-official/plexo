// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo } from 'react'
import { BarChart3 } from 'lucide-react'

import type { WorkRendererProps } from '../types'

/**
 * ChartRenderer — renders `kind: 'chart'` works. The work body must be
 * a JSON object like `{ "data": [{ "x": "Jan", "y": 10 }, ...] }` or a
 * bare array. Chart type from `meta.chartType`: line / bar / area / pie.
 * We render with plain SVG so we do not pull in a large chart dep
 * (recharts was considered but adds ~120KB gzipped for four types we
 * already know the shape of).
 */
type ChartType = 'line' | 'bar' | 'area' | 'pie'

interface DataPoint { x: string | number, y: number }
interface ChartSpec { data: Record<string, unknown>[], xKey?: string, yKey?: string }

const WIDTH = 560
const HEIGHT = 280
const PADDING = { top: 20, right: 20, bottom: 40, left: 48 }

export function ChartRenderer({ work }: WorkRendererProps) {
    const parsed = useMemo(() => parseChart(work.content), [work.content])
    const chartType = ((work.meta?.chartType as string | undefined) || 'bar') as ChartType
    const color = (work.meta?.color as string | undefined) || '#3b82f6'

    if (parsed.error) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-text-muted">
                <BarChart3 className="h-10 w-10 text-text-muted/50" />
                <div className="text-sm">Could not parse chart data: {parsed.error}</div>
                {work.content && (
                    <pre className="mt-2 w-full max-w-2xl text-left text-[11px] font-mono text-text-primary/80 bg-surface-1/40 p-3 rounded overflow-auto">{work.content}</pre>
                )}
            </div>
        )
    }

    if (!parsed.data || parsed.data.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-text-muted">
                <BarChart3 className="h-10 w-10 text-text-muted/50" />
                <div className="text-sm">No chart data found.</div>
            </div>
        )
    }

    const data = parsed.data
    const title = (work.meta?.title as string | undefined) || work.filename

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
                    <p className="text-[11px] text-text-muted uppercase tracking-wider">{chartType} chart</p>
                </div>
                <span className="text-[10px] text-text-muted">{data.length} points</span>
            </div>
            <div className="rounded border border-border bg-surface-1/30 p-4">
                {chartType === 'pie'
                    ? <PieSvg data={data} color={color} />
                    : <CartesianSvg data={data} color={color} chartType={chartType} />
                }
            </div>
        </div>
    )
}

export function parseChart(body: string | null | undefined): { data: DataPoint[] | null, error: string | null } {
    if (!body) return { data: null, error: null }
    try {
        const parsed = JSON.parse(body.trim())
        let data: DataPoint[]
        if (Array.isArray(parsed)) {
            data = normalizePoints(parsed)
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ChartSpec).data)) {
            const spec = parsed as ChartSpec
            const xKey = spec.xKey ?? 'x'
            const yKey = spec.yKey ?? 'y'
            data = spec.data.map((p, i) => ({
                x: (p?.[xKey] ?? i) as string | number,
                y: Number(p?.[yKey] ?? 0),
            }))
        } else {
            return { data: null, error: 'Expected array or { data, xKey, yKey }' }
        }
        if (data.some(p => Number.isNaN(p.y))) {
            return { data: null, error: 'Non-numeric y values' }
        }
        return { data, error: null }
    } catch (e) {
        return { data: null, error: (e as Error).message }
    }
}

function normalizePoints(arr: unknown[]): DataPoint[] {
    return arr.map((p, i) => {
        if (p == null) return { x: i, y: 0 }
        if (typeof p === 'number') return { x: i, y: p }
        if (typeof p === 'object') {
            const obj = p as Record<string, unknown>
            if ('x' in obj && 'y' in obj) return { x: obj.x as string | number, y: Number(obj.y) }
            const keys = Object.keys(obj)
            const xKey = keys.find(k => typeof obj[k] !== 'number') ?? keys[0]
            const yKey = keys.find(k => typeof obj[k] === 'number') ?? keys[keys.length - 1]
            return { x: (obj[xKey!] ?? i) as string | number, y: Number(obj[yKey!] ?? 0) }
        }
        return { x: i, y: 0 }
    })
}

function CartesianSvg({ data, color, chartType }: { data: DataPoint[], color: string, chartType: ChartType }) {
    const innerW = WIDTH - PADDING.left - PADDING.right
    const innerH = HEIGHT - PADDING.top - PADDING.bottom

    const ys = data.map(d => d.y)
    const maxY = Math.max(...ys, 0)
    const minY = Math.min(...ys, 0)
    const range = maxY - minY || 1

    const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW / 2
    const x = (i: number) => PADDING.left + (data.length > 1 ? i * xStep : innerW / 2)
    const y = (v: number) => PADDING.top + innerH - ((v - minY) / range) * innerH

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(p => ({
        v: minY + p * range,
        y: PADDING.top + innerH - p * innerH,
    }))

    return (
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto text-text-muted">
            {yTicks.map((t, i) => (
                <g key={i}>
                    <line x1={PADDING.left} y1={t.y} x2={WIDTH - PADDING.right} y2={t.y}
                        stroke="currentColor" strokeOpacity="0.12" strokeDasharray="2 4" />
                    <text x={PADDING.left - 6} y={t.y + 3} textAnchor="end"
                        className="fill-current" style={{ fontSize: 9 }}>
                        {formatNumber(t.v)}
                    </text>
                </g>
            ))}
            <line x1={PADDING.left} y1={HEIGHT - PADDING.bottom} x2={WIDTH - PADDING.right} y2={HEIGHT - PADDING.bottom}
                stroke="currentColor" strokeOpacity="0.3" />
            <line x1={PADDING.left} y1={PADDING.top} x2={PADDING.left} y2={HEIGHT - PADDING.bottom}
                stroke="currentColor" strokeOpacity="0.3" />

            {data.map((d, i) => {
                if (data.length > 12 && i % Math.ceil(data.length / 12) !== 0) return null
                return (
                    <text key={i} x={x(i)} y={HEIGHT - PADDING.bottom + 14} textAnchor="middle"
                        className="fill-current" style={{ fontSize: 9 }}>
                        {String(d.x).slice(0, 10)}
                    </text>
                )
            })}

            {chartType === 'bar' && (() => {
                const gap = Math.max(2, xStep * 0.2)
                const bw = data.length > 1 ? xStep - gap : innerW * 0.4
                return data.map((d, i) => {
                    const bx = x(i) - bw / 2
                    const by = y(Math.max(d.y, 0))
                    const bh = Math.abs(y(d.y) - y(0))
                    return <rect key={i} x={bx} y={by} width={bw} height={bh} fill={color} rx="2" />
                })
            })()}

            {(chartType === 'line' || chartType === 'area') && data.length > 1 && (() => {
                const points = data.map((d, i) => `${x(i)},${y(d.y)}`).join(' ')
                return (
                    <>
                        {chartType === 'area' && (
                            <polygon
                                points={`${x(0)},${y(0)} ${points} ${x(data.length - 1)},${y(0)}`}
                                fill={color}
                                fillOpacity="0.2"
                            />
                        )}
                        <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
                        {data.map((d, i) => (
                            <circle key={i} cx={x(i)} cy={y(d.y)} r="2.5" fill={color} />
                        ))}
                    </>
                )
            })()}
        </svg>
    )
}

const PIE_PALETTE = [
    '#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4',
]

function PieSvg({ data }: { data: DataPoint[], color: string }) {
    const total = data.reduce((sum, d) => sum + Math.max(d.y, 0), 0)
    if (total <= 0) {
        return <div className="text-sm text-text-muted p-6 text-center">All values are zero.</div>
    }
    const cx = WIDTH / 2
    const cy = HEIGHT / 2
    const r = Math.min(WIDTH, HEIGHT) / 2 - 30
    type Slice = { path: string; color: string; label: string; pct: number; _end: number }
    const slices = data.reduce<Slice[]>((acc, d, i) => {
        const prevAngle = acc.length > 0 ? acc[acc.length - 1]!._end : -Math.PI / 2
        const pct = Math.max(d.y, 0) / total
        const start = prevAngle
        const end = prevAngle + pct * Math.PI * 2
        const large = end - start > Math.PI ? 1 : 0
        const x1 = cx + r * Math.cos(start)
        const y1 = cy + r * Math.sin(start)
        const x2 = cx + r * Math.cos(end)
        const y2 = cy + r * Math.sin(end)
        const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
        acc.push({ path, color: PIE_PALETTE[i % PIE_PALETTE.length]!, label: String(d.x), pct, _end: end })
        return acc
    }, [])

    return (
        <div className="flex flex-col md:flex-row items-center gap-4">
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="max-w-md h-auto">
                {slices.map((s, i) => (
                    <path key={i} d={s.path} fill={s.color} stroke="#0a0a0a" strokeWidth="1" />
                ))}
            </svg>
            <ul className="flex flex-col gap-1 text-[11px]">
                {slices.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
                        <span className="text-text-primary truncate max-w-[140px]">{s.label}</span>
                        <span className="text-text-muted">{(s.pct * 100).toFixed(1)}%</span>
                    </li>
                ))}
            </ul>
        </div>
    )
}

function formatNumber(n: number): string {
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k'
    if (Number.isInteger(n)) return String(n)
    return n.toFixed(2)
}
