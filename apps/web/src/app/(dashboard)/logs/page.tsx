// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { ChevronRight, RefreshCw, CircleDashed, Terminal } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
    id: string
    type: string
    status: string
    source: string
    project: string | null
    context: Record<string, unknown>
    qualityScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    outcomeSummary: string | null
    createdAt: string | null
    claimedAt: string | null
    completedAt: string | null
}

const STATUS_STYLES: Record<string, string> = {
    complete: 'bg-azure-950 text-azure border-emerald-800',
    running: 'bg-blue-950 text-blue-400 border-blue-800',
    queued: 'bg-surface-2 text-text-secondary border-border',
    blocked: 'bg-amber-950 text-amber border-amber-800',
    failed: 'bg-red-950 text-red border-red-800',
    cancelled: 'bg-surface-1 text-text-muted border-border',
}

const SOURCE_COLOR: Record<string, string> = {
    chat: 'text-violet-400',
    telegram: 'text-sky-400',
    cron: 'text-amber',
    api: 'text-text-secondary',
    sprint: 'text-azure',
}

function taskDescription(ctx: Record<string, unknown>): string {
    for (const k of ['description', 'prompt', 'message', 'input']) {
        if (typeof ctx[k] === 'string' && (ctx[k] as string).length > 0) return ctx[k] as string
    }
    return ''
}

function elapsedStr(start: string | null, end: string | null): string | null {
    if (!start || !end) return null
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (isNaN(ms) || ms < 0) return null
    return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`
}

function relativeTime(iso: string | null): string {
    if (!iso) return '—'
    const diff = Date.now() - new Date(iso).getTime()
    if (isNaN(diff)) return '—'
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function LogsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [logs, setLogs] = useState<LogEntry[]>([])
    const [loading, setLoading] = useState(true)

    const lf = useListFilter(['status', 'source'], 'newest')

    const fetchLogsData = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
            const res = await fetch(
                `${API_BASE}/api/v1/dashboard/activity?workspaceId=${encodeURIComponent(WS_ID)}&limit=100`,
                { cache: 'no-store' }
            )
            if (res.ok) {
                const data = await res.json() as { items?: LogEntry[] }
                setLogs(data.items ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchLogsData() }, [fetchLogsData])

    // Compute dimensions
    const availableStatuses = useMemo(() => new Set(logs.map(l => l.status)), [logs])
    const availableSources = useMemo(() => new Set(logs.map(l => l.source)), [logs])

    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'status',
            label: 'Status',
            options: (['complete', 'running', 'queued', 'blocked', 'failed', 'cancelled'] as const).map((s) => ({
                value: s,
                label: s.charAt(0).toUpperCase() + s.slice(1),
                icon: <CircleDashed className="h-3 w-3 mr-1 shrink-0" />,
                dimmed: !availableStatuses.has(s),
            })),
        },
        {
            key: 'source',
            label: 'Source',
            options: Array.from(availableSources).sort().map((s) => ({
                value: s,
                label: s.charAt(0).toUpperCase() + s.slice(1),
                icon: <Terminal className="h-3 w-3 mr-1 shrink-0" />,
                dimmed: !availableSources.has(s),
            })),
        },
    ], [availableStatuses, availableSources])

    // Filter & Sort
    const filtered = useMemo(() => {
        let out = [...logs]

        if (lf.filterValues.status) out = out.filter(l => l.status === lf.filterValues.status)
        if (lf.filterValues.source) out = out.filter(l => l.source === lf.filterValues.source)

        if (lf.search.trim()) {
            const q = lf.search.toLowerCase()
            out = out.filter((l) => {
                const desc = taskDescription(l.context ?? {}).toLowerCase()
                return (
                    l.type.toLowerCase().includes(q) ||
                    desc.includes(q) ||
                    l.id.toLowerCase().includes(q) ||
                    (l.outcomeSummary && l.outcomeSummary.toLowerCase().includes(q))
                )
            })
        }

        out.sort((a, b) => {
            const tA = new Date(a.completedAt ?? a.claimedAt ?? a.createdAt ?? 0).getTime()
            const tB = new Date(b.completedAt ?? b.claimedAt ?? b.createdAt ?? 0).getTime()

            if (lf.sort === 'newest') return tB - tA
            if (lf.sort === 'oldest') return tA - tB
            if (lf.sort === 'highest_cost') return (b.costUsd ?? 0) - (a.costUsd ?? 0)
            if (lf.sort === 'highest_quality') return (b.qualityScore ?? 0) - (a.qualityScore ?? 0)

            return tB - tA
        })

        return out
    }, [logs, lf.search, lf.filterValues.status, lf.filterValues.source, lf.sort])

    return (
        <div className="flex flex-col gap-6 max-w-5xl">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Logs</h1>
                    <p className="mt-0.5 text-sm text-text-muted">Agent work ledger — {logs.length} entries</p>
                </div>
                <button
                    onClick={() => void fetchLogsData()}
                    disabled={loading}
                    title="Refresh Activity"
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            <ListToolbar
                hook={lf}
                placeholder="Search description, summary, ID…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Highest cost', value: 'highest_cost' },
                    { label: 'Highest quality', value: 'highest_quality' },
                ]}
            />

            {loading ? (
                <div className="flex items-center justify-center py-16 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Loading logs…
                </div>
            ) : logs.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    <p className="text-sm text-text-muted">No log entries yet</p>
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-12 text-center">
                    <p className="text-sm text-text-muted">No logs match your filters.</p>
                    <button onClick={lf.clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        Clear filters
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((log) => {
                        const dur = elapsedStr(log.claimedAt ?? log.createdAt, log.completedAt)
                        const desc = taskDescription(log.context ?? {})
                        const ts = log.completedAt ?? log.claimedAt ?? log.createdAt
                        return (
                            <Link
                                key={log.id}
                                href={`/logs/${log.id}`}
                                className="group flex items-center gap-4 rounded-xl border border-border bg-surface-1/40 px-4 py-3.5 transition-colors hover:border-border hover:bg-surface-1/80"
                            >
                                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[log.status] ?? 'bg-surface-2 text-text-muted border-border'}`}>
                                    {log.status}
                                </span>

                                <span className={`shrink-0 w-16 text-xs font-medium capitalize ${SOURCE_COLOR[log.source] ?? 'text-text-muted'}`}>
                                    {log.source}
                                </span>

                                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted capitalize">
                                    {log.type}
                                </span>

                                <span className="flex-1 truncate text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                                    {desc ? desc.slice(0, 120) : <span className="italic text-text-muted">{log.type} task</span>}
                                </span>

                                {log.outcomeSummary && (
                                    <span className="hidden xl:block max-w-[200px] truncate text-xs text-text-muted">
                                        {log.outcomeSummary.slice(0, 80)}
                                    </span>
                                )}

                                <div className="flex shrink-0 items-center justify-end gap-4 text-xs text-text-muted w-[240px]">
                                    {log.tokensIn != null && (
                                        <span className="hidden lg:block truncate max-w-[80px]">
                                            {((log.tokensIn ?? 0) + (log.tokensOut ?? 0)).toLocaleString()} tok
                                        </span>
                                    )}
                                    {log.costUsd != null && log.costUsd > 0 && (
                                        <span className="hidden lg:block text-text-muted truncate max-w-[60px]">${log.costUsd.toFixed(4)}</span>
                                    )}
                                    {dur && <span className="hidden lg:block w-12 text-right">{dur}</span>}
                                    {log.qualityScore != null && (
                                        <span className={log.qualityScore >= 0.8 ? 'text-azure hidden sm:block w-8 text-right' : log.qualityScore >= 0.5 ? 'text-amber hidden sm:block w-8 text-right' : 'text-red hidden sm:block w-8 text-right'}>
                                            {Math.round(log.qualityScore * 100)}%
                                        </span>
                                    )}
                                    <span className="text-zinc-700 min-w-[4rem] text-right">{relativeTime(ts)}</span>
                                </div>

                                <ChevronRight size={14} className="shrink-0 text-zinc-700 group-hover:text-text-muted transition-colors" />
                            </Link>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
