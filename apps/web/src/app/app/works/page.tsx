// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { FileOutput, Loader2, X, AlertCircle, RefreshCw, ChevronDown, ExternalLink } from 'lucide-react'
import { EmptyState } from '@web/components/ui/empty-state'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { jsonFetcher } from '@web/lib/swr'
import { KindBadge } from '@web/components/works/KindBadge'
import { WorkRenderer } from '@web/components/works/WorkRenderer'
import type { WorkKind } from '@web/components/works/infer-kind-client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkItem {
    id: string
    filename: string
    kind: WorkKind | null
    type: string
    meta: Record<string, unknown>
    currentVersion: number
    taskId: string | null
    projectId: string | null
    createdAt: string
    updatedAt: string
    contentLength: number
    taskSource: string | null
    taskSummary: string | null
    // Loaded on expand
    content?: string | null
}

// ── Config ────────────────────────────────────────────────────────────────────

const WORK_KINDS: WorkKind[] = [
    'markdown', 'instructions', 'code', 'html', 'mockup', 'json', 'yaml',
    'table', 'checklist', 'image', 'diagram', 'chart', 'config', 'link-list', 'file',
]

const SOURCES = ['telegram', 'slack', 'discord', 'dashboard', 'api', 'cron', 'scanner', 'github', 'extension', 'sentry'] as const

const FILTER_KEYS = ['kind', 'source'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(iso: string) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
}

function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WorksPage() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()

    const workspaceId = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    // ── Filter state ──────────────────────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters, clearAll } = lf

    // ── SWR data fetching ─────────────────────────────────────────────────────
    const worksKey = useMemo(() => {
        if (!workspaceId) return null
        const params = new URLSearchParams({ workspaceId, limit: '100' })
        if (filterValues.kind) params.set('kind', filterValues.kind)
        if (filterValues.source) params.set('source', filterValues.source)
        return `${apiBase}/api/v1/works?${params.toString()}`
    }, [workspaceId, apiBase, filterValues.kind, filterValues.source])

    const {
        data: worksData,
        error: fetchError,
        isLoading,
        isValidating,
        mutate: refetch,
    } = useSWR<{ items: WorkItem[] }>(worksKey, jsonFetcher, {
        dedupingInterval: 10_000,
        revalidateOnFocus: true,
        keepPreviousData: true,
    })
    const works = worksData?.items ?? []
    const loading = isLoading && !worksData
    const refreshing = isValidating && !isLoading

    // ── Derived data ──────────────────────────────────────────────────────────
    const availableKinds = useMemo(() => new Set(works.map(w => w.kind).filter(Boolean)), [works])
    const availableSources = useMemo(() => new Set(works.map(w => w.taskSource).filter(Boolean)), [works])

    // Client-side: text search + sort
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = works

        if (q) {
            result = result.filter(w =>
                w.filename.toLowerCase().includes(q) ||
                (w.kind?.toLowerCase().includes(q) ?? false) ||
                (w.taskSummary?.toLowerCase().includes(q) ?? false),
            )
        }

        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            if (lf.sort === 'largest') {
                return (b.contentLength ?? 0) - (a.contentLength ?? 0)
            }
            // default 'newest'
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [works, search, lf.sort])

    // ── Filter dimensions ─────────────────────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'kind',
            label: 'Kind',
            options: WORK_KINDS.map(k => ({
                value: k,
                label: k,
                dimmed: !availableKinds.has(k),
            })),
        },
        {
            key: 'source',
            label: 'Source',
            options: SOURCES.map(s => ({
                value: s,
                label: s,
                dimmed: !availableSources.has(s),
            })),
        },
    ], [availableKinds, availableSources])

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-text-primary">Works</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {loading
                            ? '...'
                            : `${displayed.length}${displayed.length !== works.length ? ` of ${works.length}` : ''} work${works.length === 1 ? '' : 's'}`}
                    </p>
                </div>
                <button
                    onClick={() => void refetch()}
                    disabled={refreshing}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by filename, kind, or task summary..."
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Largest first', value: 'largest' },
                ]}
            />

            {/* Works list */}
            {fetchError && !worksData ? (
                <div className="rounded-xl border border-red-800/40 bg-red-dim p-8 text-center">
                    <AlertCircle className="h-5 w-5 text-red mx-auto mb-2" />
                    <p className="text-sm text-red">Failed to load works</p>
                    <button onClick={() => refetch()} className="mt-2 text-xs text-text-muted underline">Retry</button>
                </div>
            ) : loading ? (
                <div className="flex items-center justify-center py-16 text-text-muted">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 p-12 text-center">
                    {hasFilters ? (
                        <>
                            <p className="text-sm text-text-muted">No works match your filters</p>
                            <button
                                onClick={clearAll}
                                className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mx-auto"
                            >
                                <X className="h-3.5 w-3.5" /> Clear filters
                            </button>
                        </>
                    ) : (
                        <EmptyState
                            icon={FileOutput}
                            headline="No works yet"
                            description="Works appear here when agents produce files and deliverables."
                        />
                    )}
                </div>
            ) : (
                <WorksList works={displayed} formatAge={formatAge} formatSize={formatSize} />
            )}
        </div>
    )
}

// ── WorksList — expandable rows that show content inline ─────────────────────

function WorksList({ works, formatAge, formatSize }: {
    works: WorkItem[]
    formatAge: (iso: string) => string
    formatSize: (bytes: number) => string
}) {
    const [openId, setOpenId] = useState<string | null>(null)
    const [contentCache, setContentCache] = useState<Record<string, string>>({})
    const [loadingContent, setLoadingContent] = useState(false)

    const toggle = useCallback(async (work: WorkItem) => {
        if (openId === work.id) { setOpenId(null); return }
        setOpenId(work.id)
        if (contentCache[work.id]) return
        if (!work.taskId) return
        setLoadingContent(true)
        try {
            const r = await fetch(`/api/v1/tasks/${work.taskId}/assets`)
            if (!r.ok) return
            const data = await r.json() as { items?: Array<{ filename: string; content?: string | null }> }
            const match = data.items?.find(a => a.filename === work.filename)
            if (match?.content) {
                setContentCache(prev => ({ ...prev, [work.id]: match.content! }))
            }
        } catch { /* silent */ }
        finally { setLoadingContent(false) }
    }, [openId, contentCache])

    return (
        <div className="flex flex-col gap-2">
            {works.map((work) => {
                const isOpen = openId === work.id
                const content = contentCache[work.id]
                return (
                    <div key={work.id} className="rounded-xl border border-border bg-surface-1/40 overflow-hidden transition-all">
                        <button
                            onClick={() => void toggle(work)}
                            className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 w-full text-left px-4 py-3.5 hover:bg-surface-1/70 transition-all group"
                        >
                            <div className="flex items-start sm:items-center gap-4 flex-1 min-w-0">
                                <ChevronDown className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                        {work.kind && <KindBadge kind={work.kind} size="sm" />}
                                        <span className="text-[11px] font-mono text-text-muted opacity-40 group-hover:opacity-100 transition-opacity">
                                            v{work.currentVersion}
                                        </span>
                                        {work.taskSource && (
                                            <span className="rounded bg-surface-2/50 px-1.5 py-0.5 text-[10px] text-text-muted opacity-60 uppercase tracking-tight">
                                                {work.taskSource}
                                            </span>
                                        )}
                                    </div>
                                    <p className="truncate text-sm font-medium text-text-primary group-hover:text-azure transition-colors leading-normal">
                                        {work.filename}
                                    </p>
                                    {!isOpen && work.taskSummary && (
                                        <p className="truncate text-xs text-text-muted mt-0.5 max-w-lg">
                                            {work.taskSummary}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-5 shrink-0">
                                <div className="flex flex-col items-end text-[11px] text-text-muted font-mono">
                                    <span>{formatAge(work.createdAt)}</span>
                                    <span>{formatSize(work.contentLength)}</span>
                                </div>
                            </div>
                        </button>

                        {isOpen && (
                            <div className="border-t border-border px-4 py-4">
                                {loadingContent && !content ? (
                                    <div className="flex items-center gap-2 text-text-muted text-sm py-4">
                                        <Loader2 className="h-4 w-4 animate-spin" /> Loading content...
                                    </div>
                                ) : content ? (
                                    <div className="max-h-[600px] overflow-auto">
                                        <WorkRenderer
                                            work={{ filename: work.filename, kind: work.kind ?? 'markdown', content, meta: work.meta, bytes: work.contentLength, isText: true }}
                                        />
                                    </div>
                                ) : (
                                    <p className="text-sm text-text-muted">Content not available</p>
                                )}
                                {work.taskId && (
                                    <div className="mt-3 pt-3 border-t border-border/50">
                                        <Link
                                            href={`/app/tasks/${work.taskId}`}
                                            className="inline-flex items-center gap-1.5 text-[11px] text-text-muted hover:text-azure transition-colors"
                                        >
                                            <ExternalLink className="h-3 w-3" /> View parent task
                                        </Link>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
