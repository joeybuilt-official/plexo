// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    CheckCircle,
    Clock,
    XCircle,
    Loader2,
    MessageSquare,
    MessageCircle,
    ExternalLink,
    Info,
    Layers,
} from 'lucide-react'
import Link from 'next/link'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { useWorkspace } from '@web/context/workspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConversationItem {
    id: string
    source: string
    message: string
    reply: string | null
    errorMsg: string | null
    status: string
    intent: string | null
    sessionId: string | null
    taskId: string | null
    createdAt: string
    // From groupBySession mode:
    turn_count?: number | string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const FILTER_KEYS = ['status', 'source'] as const

// ── Badge maps ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, React.ReactElement> = {
    pending: <Clock className="h-3.5 w-3.5 text-amber" />,
    complete: <CheckCircle className="h-3.5 w-3.5 text-emerald" />,
    failed: <XCircle className="h-3.5 w-3.5 text-red" />,
}

const ALL_STATUSES = ['pending', 'complete', 'failed'] as const

const SOURCE_BADGE: Record<string, { icon: string; label: string; className: string }> = {
    telegram: { icon: '✈️', label: 'Telegram', className: 'bg-sky-900/40 text-sky-400 border border-sky-800/50' },
    slack: { icon: '⚡', label: 'Slack', className: 'bg-purple-900/40 text-purple-400 border border-purple-800/50' },
    discord: { icon: '💬', label: 'Discord', className: 'bg-indigo-900/40 text-indigo border border-indigo-800/50' },
    github: { icon: '🐙', label: 'GitHub', className: 'bg-surface-2 text-text-secondary border border-border/50' },
    dashboard: { icon: '🖥', label: 'Dashboard', className: 'bg-surface-2/60 text-text-muted border border-border/40' },
    api: { icon: '🔗', label: 'API', className: 'bg-surface-2/60 text-text-muted border border-border/40' },
    widget: { icon: '💬', label: 'Widget', className: 'bg-teal-900/40 text-teal-400 border border-teal-800/50' },
}
const DEFAULT_SOURCE_BADGE = { icon: '🖥', label: 'Unknown', className: 'bg-surface-2/60 text-text-muted border border-border/40' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByDate(items: ConversationItem[]) {
    const groups: Record<string, ConversationItem[]> = {}
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

function getPreview(item: ConversationItem): string {
    if (item.reply) return item.reply
    if (item.errorMsg) return item.errorMsg
    return item.message
}

/** Returns the href that "Continue conversation" should navigate to */
function continueHref(item: ConversationItem): string {
    // If the item has a sessionId, restore the full thread context
    if (item.sessionId) return `/chat?sessionId=${encodeURIComponent(item.sessionId)}`
    // Otherwise fall back to single-turn context
    return `/chat?context=${encodeURIComponent(item.id)}`
}

/** Returns the number of turns in a session, shown as a label */
function turnLabel(item: ConversationItem): string | null {
    const n = typeof item.turn_count === 'string' ? parseInt(item.turn_count, 10) : (item.turn_count ?? 1)
    if (!n || n <= 1) return null
    return `${n} turns`
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRow() {
    return (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-1/40 p-4 animate-pulse">
            <div className="mt-0.5 h-3.5 w-3.5 rounded-full bg-surface-2 shrink-0" />
            <div className="flex-1 space-y-2">
                <div className="flex gap-2">
                    <div className="h-3 w-16 rounded bg-surface-2" />
                    <div className="h-3 w-12 rounded bg-surface-2" />
                </div>
                <div className="h-3 w-3/4 rounded bg-surface-2" />
                <div className="h-2.5 w-20 rounded bg-surface-2" />
            </div>
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
    workspaceId: string
    initialItems: ConversationItem[]
}

export function ConversationsList({ workspaceId: propWorkspaceId, initialItems }: Props) {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const workspaceId = ctxWorkspaceId || propWorkspaceId

    const workspaceMismatch = !!ctxWorkspaceId && ctxWorkspaceId !== propWorkspaceId
    const [items, setItems] = useState<ConversationItem[]>(workspaceMismatch ? [] : initialItems)
    const [loading, setLoading] = useState(workspaceMismatch)
    const esRef = useRef<EventSource | null>(null)

    // ── Filter state ─────────────────────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters, clearAll } = lf

    // ── Data fetching — grouped sessions mode ─────────────────────────────────
    const fetchConversations = useCallback(async () => {
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/conversations?workspaceId=${encodeURIComponent(workspaceId)}&limit=100&groupBySession=true`,
                { cache: 'no-store' },
            )
            if (!res.ok) return
            const data = (await res.json()) as { items: ConversationItem[] }
            setItems(data.items ?? [])
        } catch {
            // silent — keep stale data
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => {
        if (workspaceMismatch || ctxWorkspaceId) {
            void fetchConversations()
        }
        const t = setInterval(() => void fetchConversations(), 15_000)
        return () => clearInterval(t)
    }, [fetchConversations, workspaceMismatch, ctxWorkspaceId])

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
                    if (['task_complete', 'task_failed', 'task_queued', 'conversation_updated'].includes(event.type)) {
                        void fetchConversations()
                    }
                } catch { /* malformed */ }
            }
            es.onerror = () => { es.close(); esRef.current = null }
        } catch {
            return
        }
        return () => { es.close(); esRef.current = null }
    }, [workspaceId, fetchConversations])

    // ── Derived sources ───────────────────────────────────────────────────────
    const availableSources = useMemo(() => new Set(items.map((i) => i.source)), [items])
    const availableStatuses = useMemo(() => new Set(items.map((i) => i.status)), [items])

    // ── Client-side filtering & sorting ───────────────────────────────────────
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = items.filter((item) => {
            if (filterValues.status && item.status !== filterValues.status) return false
            if (filterValues.source && item.source !== filterValues.source) return false
            if (q) {
                const preview = getPreview(item)
                return (
                    item.id.toLowerCase().includes(q) ||
                    item.source.toLowerCase().includes(q) ||
                    item.status.toLowerCase().includes(q) ||
                    item.message.toLowerCase().includes(q) ||
                    (preview?.toLowerCase().includes(q) ?? false)
                )
            }
            return true
        })
        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
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
                <p className="mt-0.5 text-sm text-text-muted">
                    {loading
                        ? 'Loading…'
                        : items.length > 0
                            ? `${displayed.length}${displayed.length !== items.length ? ` of ${items.length}` : ''} thread${items.length === 1 ? '' : 's'}`
                            : 'Chat history from all channels'}
                </p>
            </div>

            {/* Search + filter + sort toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by source, message, or outcome…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                ]}
            />

            {/* Content */}
            {loading ? (
                <div className="flex flex-col gap-2">
                    {[0, 1, 2].map(i => <SkeletonRow key={i} />)}
                </div>
            ) : items.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    <MessageSquare className="mx-auto h-8 w-8 text-zinc-700 mb-3" />
                    <p className="text-sm text-text-muted">No conversations yet</p>
                    <p className="mt-1 text-xs text-text-muted">Start a chat from the dashboard to see history here.</p>
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    <p className="text-sm text-text-muted">No conversations match your filters</p>
                    <button
                        onClick={clearAll}
                        className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto"
                    >
                        Clear filters
                    </button>
                </div>
            ) : (
                Object.entries(groups).map(([date, groupItems]) => (
                    <div key={date}>
                        <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{date}</p>
                        <div className="flex flex-col gap-2">
                            {groupItems.map((item) => {
                                const preview = getPreview(item)
                                const badge = SOURCE_BADGE[item.source] ?? DEFAULT_SOURCE_BADGE
                                const isFailed = item.status === 'failed'
                                const turns = turnLabel(item)
                                const isThread = !!(item.sessionId && turns)

                                return (
                                    <div
                                        key={item.id}
                                        className="flex items-start gap-3 rounded-xl border border-border bg-surface-1/40 p-4 hover:border-border transition-colors group"
                                    >
                                        <span className="mt-0.5 shrink-0">
                                            {STATUS_ICON[item.status] ?? STATUS_ICON['pending']}
                                        </span>
                                        {/* Clickable body → thread detail or single conversation */}
                                        <Link
                                            href={
                                                item.sessionId
                                                    ? `/conversations/thread?sessionId=${encodeURIComponent(item.sessionId)}`
                                                    : `/conversations/${encodeURIComponent(item.id)}`
                                            }
                                            className="flex-1 min-w-0 block hover:opacity-80 transition-opacity"
                                        >
                                            {/* User message */}
                                            <p className="text-sm text-text-primary leading-snug line-clamp-2">{item.message}</p>
                                            {/* Reply or error */}
                                            {preview && preview !== item.message && (
                                                <p className={`mt-1 text-xs leading-snug line-clamp-2 ${isFailed ? 'text-red/80' : 'text-text-muted'}`}>
                                                    {isFailed ? '⚠ ' : '↳ '}{preview}
                                                </p>
                                            )}
                                            <div className="mt-2 flex items-center gap-2 flex-wrap">
                                                <span className={`rounded px-1.5 py-0.5 text-[9px] flex items-center gap-1 ${badge.className}`}>
                                                    {badge.icon} {badge.label}
                                                </span>
                                                {item.intent && item.intent !== 'CONVERSATION' && (
                                                    <span className="rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 text-[9px] text-indigo capitalize">
                                                        {item.intent.toLowerCase()}
                                                    </span>
                                                )}
                                                {isThread && (
                                                    <span className="flex items-center gap-0.5 rounded bg-surface-2 border border-border/50 px-1.5 py-0.5 text-[9px] text-text-muted">
                                                        <Layers className="h-2.5 w-2.5" /> {turns}
                                                    </span>
                                                )}
                                                <span className="text-[10px] text-text-muted">
                                                    {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </div>
                                        </Link>

                                        <div className="flex items-center gap-1 shrink-0">
                                            {/* Linked task */}
                                            {item.taskId && (
                                                <Link
                                                    href={`/tasks/${item.taskId}`}
                                                    className="rounded-lg p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                                                    title="View spawned task"
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                </Link>
                                            )}
                                            {/* Conversation info / detail */}
                                            <Link
                                                href={
                                                    item.sessionId
                                                        ? `/conversations/thread?sessionId=${encodeURIComponent(item.sessionId)}`
                                                        : `/conversations/${encodeURIComponent(item.id)}`
                                                }
                                                className="rounded-lg p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                                                title={isThread ? 'View thread' : 'Conversation info'}
                                            >
                                                <Info className="h-4 w-4" />
                                            </Link>
                                            {/* Continue in chat */}
                                            <Link
                                                href={continueHref(item)}
                                                className="rounded-lg p-1.5 text-text-muted hover:text-indigo hover:bg-surface-2 transition-colors"
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
