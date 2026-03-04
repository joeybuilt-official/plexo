'use client'

import { useEffect, useState, useCallback } from 'react'
import { useWorkspace } from '@web/context/workspace'
import Link from 'next/link'
import { RefreshCw, ChevronRight } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

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
    createdAt: string
    claimedAt: string | null
    completedAt: string | null
}

const STATUS_STYLES: Record<string, string> = {
    complete: 'bg-emerald-950 text-emerald-400 border-emerald-800',
    running: 'bg-blue-950 text-blue-400 border-blue-800',
    queued: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    blocked: 'bg-amber-950 text-amber-400 border-amber-800',
    failed: 'bg-red-950 text-red-400 border-red-800',
}

const SOURCE_STYLES: Record<string, string> = {
    chat: 'text-violet-400',
    telegram: 'text-sky-400',
    cron: 'text-amber-400',
    api: 'text-zinc-400',
    sprint: 'text-emerald-400',
}

function duration(entry: LogEntry): string | null {
    const start = entry.claimedAt ?? entry.createdAt
    const end = entry.completedAt
    if (!start || !end) return null
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (isNaN(ms) || ms < 0) return null
    return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`
}

function description(entry: LogEntry): string {
    const ctx = entry.context
    if (typeof ctx?.description === 'string') return ctx.description
    if (typeof ctx?.prompt === 'string') return ctx.prompt
    if (typeof ctx?.message === 'string') return ctx.message
    return entry.outcomeSummary ?? entry.type
}

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    if (isNaN(diff)) return '—'
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function LogsPage() {
    const { workspaceId } = useWorkspace()
    const [logs, setLogs] = useState<LogEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [statusFilter, setStatusFilter] = useState<string>('all')

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(
                `${API_BASE}/api/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
                { cache: 'no-store' }
            )
            if (!res.ok) return
            const data = await res.json() as { items: LogEntry[] }
            setLogs(data.items ?? [])
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { load() }, [load])

    const statuses = ['all', ...Array.from(new Set(logs.map(l => l.status)))]
    const filtered = statusFilter === 'all' ? logs : logs.filter(l => l.status === statusFilter)

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Logs</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">Agent work ledger — {filtered.length} entries</p>
                </div>
                <button
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {/* Status filter */}
            <div className="flex gap-2 flex-wrap">
                {statuses.map(s => (
                    <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${statusFilter === s
                                ? 'border-zinc-600 bg-zinc-700 text-zinc-200'
                                : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:text-zinc-300'
                            }`}
                    >
                        {s}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">{loading ? 'Loading…' : 'No log entries yet'}</p>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((log) => {
                        const dur = duration(log)
                        const desc = description(log)
                        const ts = log.completedAt ?? log.claimedAt ?? log.createdAt
                        return (
                            <Link
                                key={log.id}
                                href={`/logs/${log.id}`}
                                className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
                            >
                                {/* Status */}
                                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[log.status] ?? 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                                    {log.status}
                                </span>

                                {/* Source */}
                                <span className={`shrink-0 w-16 text-xs font-medium capitalize ${SOURCE_STYLES[log.source] ?? 'text-zinc-500'}`}>
                                    {log.source}
                                </span>

                                {/* Type */}
                                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 capitalize">
                                    {log.type}
                                </span>

                                {/* Description */}
                                <span className="flex-1 truncate text-sm text-zinc-400 group-hover:text-zinc-200 transition-colors">
                                    {desc.slice(0, 120)}
                                </span>

                                {/* Outcome summary */}
                                {log.outcomeSummary && (
                                    <span className="hidden xl:block max-w-xs truncate text-xs text-zinc-600 group-hover:text-zinc-500">
                                        {log.outcomeSummary.slice(0, 80)}
                                    </span>
                                )}

                                {/* Metrics */}
                                <div className="flex shrink-0 items-center gap-4 text-xs text-zinc-600">
                                    {log.tokensIn != null && (
                                        <span className="hidden sm:block">
                                            {(log.tokensIn + (log.tokensOut ?? 0)).toLocaleString()} tok
                                        </span>
                                    )}
                                    {log.costUsd != null && log.costUsd > 0 && (
                                        <span className="hidden sm:block text-zinc-500">
                                            ${log.costUsd.toFixed(4)}
                                        </span>
                                    )}
                                    {dur && <span>{dur}</span>}
                                    {log.qualityScore != null && (
                                        <span className={
                                            log.qualityScore >= 0.8 ? 'text-emerald-500' :
                                                log.qualityScore >= 0.5 ? 'text-amber-500' : 'text-red-500'
                                        }>
                                            {Math.round(log.qualityScore * 100)}%
                                        </span>
                                    )}
                                    <span className="text-zinc-700 min-w-[4rem] text-right">
                                        {relativeTime(ts)}
                                    </span>
                                </div>

                                <ChevronRight size={14} className="shrink-0 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
                            </Link>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
