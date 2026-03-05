'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    CheckCircle,
    Clock,
    XCircle,
    Loader2,
    BarChart3,
    MessageSquare,
    Info,
    MessageCircle,
} from 'lucide-react'
import Link from 'next/link'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { useWorkspace } from '@web/context/workspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivityItem {
    id: string
    type: string
    status: string
    outcomeSummary: string | null
    qualityScore: number | null
    completedAt: string | null
    createdAt: string
    source: string
    context: Record<string, unknown> | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

const LIVE_EVENT_TYPES = new Set([
    'task_started',
    'task_planned',
    'task_complete',
    'task_failed',
    'task_blocked',
    'task_planning',
    'task_queued',
    'task_queued_via_telegram',
    'task_queued_via_slack',
])

// Module-level constant for useListFilter initialiser
const FILTER_KEYS = ['status', 'source'] as const

// ── Badge maps ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, React.ReactElement> = {
    pending: <Clock className="h-3.5 w-3.5 text-amber-400" />,
    queued: <Clock className="h-3.5 w-3.5 text-amber-400" />,
    claimed: <Loader2 className="h-3.5 w-3.5 text-sky-400 animate-spin" />,
    running: <Loader2 className="h-3.5 w-3.5 text-indigo-400 animate-spin" />,
    complete: <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />,
    failed: <XCircle className="h-3.5 w-3.5 text-red-400" />,
    blocked: <XCircle className="h-3.5 w-3.5 text-orange-400" />,
    cancelled: <XCircle className="h-3.5 w-3.5 text-zinc-500" />,
}

const ALL_STATUSES = ['pending', 'queued', 'running', 'complete', 'failed', 'blocked', 'cancelled'] as const

const SOURCE_BADGE: Record<string, { icon: string; label: string; className: string }> = {
    telegram: { icon: '✈️', label: 'Telegram', className: 'bg-sky-900/40 text-sky-400 border border-sky-800/50' },
    slack: { icon: '⚡', label: 'Slack', className: 'bg-purple-900/40 text-purple-400 border border-purple-800/50' },
    discord: { icon: '💬', label: 'Discord', className: 'bg-indigo-900/40 text-indigo-400 border border-indigo-800/50' },
    github: { icon: '🐙', label: 'GitHub', className: 'bg-zinc-800 text-zinc-400 border border-zinc-700/50' },
    dashboard: { icon: '🖥', label: 'Dashboard', className: 'bg-zinc-800/60 text-zinc-500 border border-zinc-700/40' },
    cron: { icon: '⏱', label: 'Cron', className: 'bg-amber-900/40 text-amber-400 border border-amber-800/50' },
    scanner: { icon: '🔍', label: 'Scanner', className: 'bg-teal-900/40 text-teal-400 border border-teal-800/50' },
    api: { icon: '🔗', label: 'API', className: 'bg-zinc-800/60 text-zinc-500 border border-zinc-700/40' },
    extension: { icon: '🧩', label: 'Extension', className: 'bg-rose-900/40 text-rose-400 border border-rose-800/50' },
}
const DEFAULT_SOURCE_BADGE = { icon: '🖥', label: 'Unknown', className: 'bg-zinc-800/60 text-zinc-500 border border-zinc-700/40' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByDate(items: ActivityItem[]) {
    const groups: Record<string, ActivityItem[]> = {}
    for (const item of items) {
        const date = new Date(item.createdAt).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
        })
        if (!groups[date]) groups[date] = []
        groups[date]!.push(item)
    }
    return groups
}

function getSummary(item: ActivityItem): string | null {
    if (item.outcomeSummary) return item.outcomeSummary
    const ctx = item.context
    if (!ctx) return null
    for (const key of ['description', 'message', 'summary'] as const) {
        const val = ctx[key]
        if (typeof val === 'string' && val.trim()) return val.trim()
    }
    return null
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
    workspaceId: string
    initialItems: ActivityItem[]
}

export function ConversationsList({ workspaceId: propWorkspaceId, initialItems }: Props) {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const workspaceId = ctxWorkspaceId || propWorkspaceId

    const [items, setItems] = useState<ActivityItem[]>(initialItems)
    const esRef = useRef<EventSource | null>(null)

    // ── Filter state (shared standard) ────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters, clearAll } = lf

    // ── Data fetching & live updates ──────────────────────────────────────────
    const fetchActivity = useCallback(async () => {
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=50`,
                { cache: 'no-store' },
            )
            if (!res.ok) return
            const data = (await res.json()) as { items: ActivityItem[] }
            setItems(data.items ?? [])
        } catch {
            // silent — keep stale data
        }
    }, [workspaceId])

    // If the client hydrated a different workspace than the server generated,
    // fetch immediately to replace the initialItems. Also poll every 15s.
    useEffect(() => {
        if (workspaceId !== propWorkspaceId) {
            void fetchActivity()
        }
        const t = setInterval(() => void fetchActivity(), 15_000)
        return () => clearInterval(t)
    }, [fetchActivity, workspaceId, propWorkspaceId])

    // SSE live updates
    useEffect(() => {
        if (typeof window === 'undefined') return
        const url = `${API_BASE}/api/v1/sse?workspaceId=${encodeURIComponent(workspaceId)}`
        let es: EventSource
        try {
            es = new EventSource(url)
            esRef.current = es
            es.onmessage = (e) => {
                try {
                    const event = JSON.parse(e.data as string) as { type: string }
                    if (LIVE_EVENT_TYPES.has(event.type)) void fetchActivity()
                } catch { /* malformed */ }
            }
            es.onerror = () => { es.close(); esRef.current = null }
        } catch {
            return
        }
        return () => { es.close(); esRef.current = null }
    }, [workspaceId, fetchActivity])

    // ── Derived sources (for dimming unavailable options) ─────────────────────
    const availableSources = useMemo(() => new Set(items.map((i) => i.source)), [items])
    const availableStatuses = useMemo(() => new Set(items.map((i) => i.status)), [items])

    // ── Client-side filtering ─────────────────────────────────────────────────
    // ── Client-side filtering & sorting ───────────────────────────────────────
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = items.filter((item) => {
            if (filterValues.status && item.status !== filterValues.status) return false
            if (filterValues.source && item.source !== filterValues.source) return false
            if (q) {
                const summary = getSummary(item)
                return (
                    item.id.toLowerCase().includes(q) ||
                    item.type.toLowerCase().includes(q) ||
                    item.source.toLowerCase().includes(q) ||
                    item.status.toLowerCase().includes(q) ||
                    (summary?.toLowerCase().includes(q) ?? false)
                )
            }
            return true
        })

        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [items, search, filterValues.status, filterValues.source, lf.sort])

    // ── Filter dimensions ─────────────────────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'status',
            label: 'Status',
            options: ALL_STATUSES.map((s) => ({
                value: s,
                label: s,
                dimmed: !availableStatuses.has(s),
            })),
        },
        {
            key: 'source',
            label: 'Source',
            options: Object.entries(SOURCE_BADGE).map(([key, meta]) => ({
                value: key,
                label: meta.label,
                icon: <span>{meta.icon}</span>,
                dimmed: !availableSources.has(key),
            })),
        },
    ], [availableStatuses, availableSources])

    const groups = groupByDate(displayed)

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-6 max-w-3xl">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Conversations</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    {items.length > 0
                        ? `${displayed.length}${displayed.length !== items.length ? ` of ${items.length}` : ''} conversation${items.length === 1 ? '' : 's'}`
                        : 'Agent task history from all channels'}
                </p>
            </div>

            {/* Search + filter + sort toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by ID, type, source, or outcome…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                ]}
            />

            {/* Content */}
            {items.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <MessageSquare className="mx-auto h-8 w-8 text-zinc-700 mb-3" />
                    <p className="text-sm text-zinc-500">No conversations yet</p>
                    <p className="mt-1 text-xs text-zinc-600">Submit a task from the dashboard to start.</p>
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">No conversations match your filters</p>
                    <button
                        onClick={clearAll}
                        className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mx-auto"
                    >
                        Clear filters
                    </button>
                </div>
            ) : (
                Object.entries(groups).map(([date, groupItems]) => (
                    <div key={date}>
                        <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{date}</p>
                        <div className="flex flex-col gap-2">
                            {groupItems.map((item) => {
                                const summary = getSummary(item)
                                const badge = SOURCE_BADGE[item.source] ?? DEFAULT_SOURCE_BADGE

                                return (
                                    <div
                                        key={item.id}
                                        className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 hover:border-zinc-700 transition-colors group"
                                    >
                                        <span className="mt-0.5 shrink-0">
                                            {STATUS_ICON[item.status] ?? STATUS_ICON['pending']}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-xs font-mono text-zinc-500">{item.id.slice(0, 8)}</span>
                                                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] capitalize text-zinc-400">{item.type}</span>
                                                <span className={`rounded px-1.5 py-0.5 text-[9px] flex items-center gap-1 ${badge.className}`}>
                                                    {badge.icon} {badge.label}
                                                </span>
                                            </div>
                                            {summary ? (
                                                <p className="mt-1.5 text-sm text-zinc-300 leading-snug line-clamp-2">{summary}</p>
                                            ) : (
                                                <p className="mt-1.5 text-xs text-zinc-600 italic">No summary available</p>
                                            )}
                                            <div className="mt-2 flex items-center gap-3 text-[10px] text-zinc-600">
                                                <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                {item.qualityScore !== null && (
                                                    <span className="flex items-center gap-1">
                                                        <BarChart3 className="h-2.5 w-2.5" />
                                                        {Math.round(item.qualityScore * 100)}%
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1 shrink-0">
                                            <Link
                                                href={`/tasks/${item.id}`}
                                                className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                                                title="View details"
                                            >
                                                <Info className="h-4 w-4" />
                                            </Link>
                                            <Link
                                                href={`/chat?context=${encodeURIComponent(item.id)}`}
                                                className="rounded-lg p-1.5 text-zinc-500 hover:text-indigo-400 hover:bg-zinc-800 transition-colors"
                                                title="Continue conversation"
                                            >
                                                <MessageCircle className="h-4 w-4" />
                                            </Link>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                ))
            )}
        </div>
    )
}
