// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import {
    Code2, Search, PenLine, Server, BarChart2, Megaphone, Sparkles,
    Plus, RefreshCw, X, Loader2, Play, Square, Trash2,
} from 'lucide-react'
import { getCategoryDef } from '@web/lib/project-categories'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Sprint {
    id: string
    repo: string | null
    category: string
    request: string
    status: string
    totalTasks: number
    completedTasks: number
    failedTasks: number
    conflictCount: number
    costUsd: number | null
    wallClockMs: number | null
    createdAt: string
    completedAt: string | null
}

// ── Config ────────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
    planning: 'bg-purple-500',
    running: 'bg-blue-500 animate-pulse',
    finalizing: 'bg-blue-400 animate-pulse',
    complete: 'bg-emerald',
    failed: 'bg-red',
    cancelled: 'bg-surface-3',
}

const STATUS_TEXT: Record<string, string> = {
    planning: 'text-purple-400',
    running: 'text-blue-400',
    finalizing: 'text-blue-300',
    complete: 'text-emerald',
    failed: 'text-red',
    cancelled: 'text-text-muted',
}

const CATEGORY_ICONS: Record<string, React.ElementType> = {
    Code2, Search, PenLine, Server, BarChart2, Megaphone, Sparkles,
}

const ALL_STATUSES = ['planning', 'running', 'finalizing', 'complete', 'failed', 'cancelled'] as const
const ALL_CATEGORIES = ['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general'] as const

// Module-level constant for useListFilter initialiser
const FILTER_KEYS = ['status', 'category'] as const

// ── Sub-components ────────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category: string }) {
    const def = getCategoryDef(category)
    const Icon = CATEGORY_ICONS[def.icon] ?? Sparkles
    return (
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-zinc-700/60 bg-surface-2/60 text-text-secondary">
            <Icon className="h-2.5 w-2.5" />
            {def.label}
        </span>
    )
}

function formatAge(iso: string) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
}

function ProjectCard({ sprint, onAction }: { sprint: Sprint, onAction: (action: 'start'|'stop'|'delete', id: string) => void }) {
    const def = getCategoryDef(sprint.category ?? 'code')
    const pct = sprint.totalTasks > 0
        ? Math.round((sprint.completedTasks / sprint.totalTasks) * 100)
        : 0
    const subtitle = sprint.category === 'code' && sprint.repo ? sprint.repo : null

    return (
        <Link
            href={`/projects/${sprint.id}`}
            className="group block rounded-xl border border-border bg-surface-1/60 p-4 transition-all hover:border-indigo/40 hover:bg-surface-1"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[sprint.status] ?? 'bg-surface-3'}`} />
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary group-hover:text-text-primary transition-colors">
                            {sprint.request.length > 80 ? sprint.request.slice(0, 80) + '…' : sprint.request}
                        </p>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <CategoryBadge category={sprint.category ?? 'code'} />
                            {subtitle && (
                                <p className="text-xs font-mono text-text-muted truncate">{subtitle}</p>
                            )}
                            <span className="text-[10px] text-zinc-700">{formatAge(sprint.createdAt)}</span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <span className={`shrink-0 text-xs font-medium ${STATUS_TEXT[sprint.status] ?? 'text-text-secondary'}`}>
                        {sprint.status}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.preventDefault()}>
                        {['cancelled', 'failed'].includes(sprint.status) && (
                            <button
                                onClick={(e) => { e.preventDefault(); onAction('start', sprint.id) }}
                                className="p-1.5 rounded-md hover:bg-surface-2 text-text-muted hover:text-indigo transition-colors"
                                title="Restart project"
                            >
                                <Play className="h-4 w-4" />
                            </button>
                        )}
                        {['planning', 'running', 'finalizing'].includes(sprint.status) && (
                            <button
                                onClick={(e) => { e.preventDefault(); onAction('stop', sprint.id) }}
                                className="p-1.5 rounded-md hover:bg-surface-2 text-text-muted hover:text-amber transition-colors"
                                title="Stop project"
                            >
                                <Square className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            onClick={(e) => { e.preventDefault(); onAction('delete', sprint.id) }}
                            className="p-1.5 rounded-md hover:bg-surface-2 text-text-muted hover:text-red transition-colors"
                            title="Delete project"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>

            {sprint.totalTasks > 0 && (
                <div className="mt-3">
                    <div className="h-1 rounded-full bg-surface-2">
                        <div className="h-1 rounded-full bg-emerald transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-text-muted">
                        <span>{sprint.completedTasks}/{sprint.totalTasks} {def.unitPlural.toLowerCase()}</span>
                        {sprint.failedTasks > 0 && <span className="text-red">{sprint.failedTasks} failed</span>}
                        {sprint.conflictCount > 0 && <span className="text-amber">{sprint.conflictCount} conflicts</span>}
                        {sprint.wallClockMs != null && sprint.wallClockMs > 0 && <span>{Math.round(sprint.wallClockMs / 1000)}s</span>}
                        {sprint.costUsd != null && <span className="ml-auto">${sprint.costUsd.toFixed(4)}</span>}
                    </div>
                </div>
            )}
        </Link>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const [sprints, setSprints] = useState<Sprint[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const workspaceId = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    // ── Filter state (shared standard) ────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters, clearAll } = lf

    // ── Data loading ──────────────────────────────────────────────────────────
    async function load(quiet = false) {
        if (!workspaceId) return
        if (!quiet) setLoading(true)
        else setRefreshing(true)
        try {
            const res = await fetch(`${apiBase}/api/v1/sprints?workspaceId=${workspaceId}&limit=100`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json() as { items: Sprint[] }
                setSprints(data.items ?? [])
            }
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }

    useEffect(() => { void load() }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── Actions ───────────────────────────────────────────────────────────────
    const handleAction = async (action: 'start'|'stop'|'delete', id: string) => {
        if (!workspaceId) return
        try {
            if (action === 'start') {
                await fetch(`${apiBase}/api/v1/sprints/${id}/run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId })
                })
            } else if (action === 'stop') {
                if (!confirm('Stop this project? All tasks will be cancelled.')) return
                await fetch(`${apiBase}/api/v1/sprints/${id}`, { method: 'DELETE' })
            } else if (action === 'delete') {
                if (!confirm('Permanently delete this project and all its history? This cannot be undone.')) return
                await fetch(`${apiBase}/api/v1/sprints/${id}?hardDelete=true`, { method: 'DELETE' })
            }
            void load(true)
        } catch (err) {
            console.error(err)
        }
    }

    // Auto-refresh while active projects exist
    useEffect(() => {
        if (!sprints.some((s) => ['planning', 'running', 'finalizing'].includes(s.status))) return
        const id = setInterval(() => void load(true), 5000)
        return () => clearInterval(id)
    }, [sprints]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── Derived ───────────────────────────────────────────────────────────────
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = sprints.filter((s) => {
            if (filterValues.status && s.status !== filterValues.status) return false
            if (filterValues.category && s.category !== filterValues.category) return false
            if (q) {
                return (
                    s.request.toLowerCase().includes(q) ||
                    s.id.toLowerCase().includes(q) ||
                    (s.repo?.toLowerCase().includes(q) ?? false) ||
                    s.category.toLowerCase().includes(q) ||
                    s.status.toLowerCase().includes(q)
                )
            }
            return true
        })

        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            if (lf.sort === 'cost_desc') {
                return (b.costUsd ?? 0) - (a.costUsd ?? 0)
            }
            if (lf.sort === 'progress_desc') {
                const percA = a.totalTasks > 0 ? a.completedTasks / a.totalTasks : 0
                const percB = b.totalTasks > 0 ? b.completedTasks / b.totalTasks : 0
                return percB - percA
            }
            if (lf.sort === 'failures_desc') {
                return b.failedTasks - a.failedTasks
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [sprints, search, filterValues.status, filterValues.category, lf.sort])

    const availableCategories = useMemo(() => new Set(sprints.map((s) => s.category)), [sprints])

    // ── Filter dimensions ─────────────────────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'status',
            label: 'Status',
            options: ALL_STATUSES.map((s) => ({ value: s, label: s })),
        },
        {
            key: 'category',
            label: 'Category',
            options: ALL_CATEGORIES.map((c) => {
                const def = getCategoryDef(c)
                const Icon = CATEGORY_ICONS[def.icon] ?? Sparkles
                return {
                    value: c,
                    label: def.label,
                    icon: <Icon className="h-3 w-3 shrink-0" />,
                    dimmed: !availableCategories.has(c),
                }
            }),
        },
    ], [availableCategories])

    // ── Summary stats ─────────────────────────────────────────────────────────
    const completed = sprints.filter((s) => s.status === 'complete')
    const finished = sprints.filter((s) => ['complete', 'failed', 'cancelled'].includes(s.status))
    const totalCost = sprints.reduce((acc, s) => acc + (s.costUsd ?? 0), 0)
    const successRate = finished.length > 0 ? Math.round((completed.length / finished.length) * 100) : null

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Projects</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {loading
                            ? '…'
                            : `${displayed.length}${displayed.length !== sprints.length ? ` of ${sprints.length}` : ''} project${sprints.length === 1 ? '' : 's'}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void load(true)}
                        disabled={refreshing}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors disabled:opacity-40"
                    >
                        <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                    <Link
                        href="/projects/new"
                        className="flex items-center gap-1.5 rounded-lg bg-indigo px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-indigo/90 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New Project
                    </Link>
                </div>
            </div>

            {/* Stats row */}
            {!loading && sprints.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {([
                        { label: 'Total', value: String(sprints.length) },
                        { label: 'Completed', value: String(completed.length), sub: successRate != null ? `${successRate}% success` : undefined },
                        { label: 'Active', value: String(sprints.filter((s) => ['planning', 'running', 'finalizing'].includes(s.status)).length) },
                        { label: 'Total spend', value: totalCost > 0 ? `$${totalCost.toFixed(3)}` : '—' },
                    ] as { label: string; value: string; sub?: string }[]).map(({ label, value, sub }) => (
                        <div key={label} className="rounded-xl border border-border bg-surface-1/40 px-4 py-3">
                            <p className="text-[11px] font-medium text-text-muted mb-1">{label}</p>
                            <p className="text-xl font-bold text-text-primary">{value}</p>
                            {sub && <p className="text-[10px] text-text-muted mt-0.5">{sub}</p>}
                        </div>
                    ))}
                </div>
            )}

            {/* Search + filter + sort toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by goal, repo, status, or category…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Highest cost', value: 'cost_desc' },
                    { label: 'Most progress', value: 'progress_desc' },
                    { label: 'Most failures', value: 'failures_desc' },
                ]}
            />

            {/* Content */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-text-muted">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
            ) : displayed.length === 0 && sprints.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-surface-1/40 py-16 text-center gap-4">
                    <div className="grid grid-cols-4 gap-2 opacity-40">
                        {[Code2, Search, PenLine, Server].map((Icon, i) => (
                            <div key={i} className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                                <Icon className="h-4 w-4 text-text-secondary" />
                            </div>
                        ))}
                    </div>
                    <div>
                        <p className="text-sm font-medium text-text-secondary">No projects yet</p>
                        <p className="mt-1 text-xs text-text-muted">Create a project to run parallel AI work — code, research, writing, and more.</p>
                    </div>
                    <Link href="/projects/new" className="flex items-center gap-2 rounded-lg bg-indigo px-4 py-2 text-sm font-medium text-text-primary hover:bg-indigo/90 transition-colors">
                        <Plus className="h-4 w-4" />
                        Create first project
                    </Link>
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    <p className="text-sm text-text-muted">No projects match your filters</p>
                    <button
                        onClick={clearAll}
                        className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto"
                    >
                        <X className="h-3.5 w-3.5" /> Clear filters
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {displayed.map((sprint) => (
                        <ProjectCard key={sprint.id} sprint={sprint} onAction={handleAction} />
                    ))}
                </div>
            )}
        </div>
    )
}
