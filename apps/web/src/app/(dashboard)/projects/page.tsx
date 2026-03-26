// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import {
    Plus, RefreshCw, X, Loader2, Play, Square, Trash2,
    ChevronRight, BarChart3, Clock, DollarSign
} from 'lucide-react'
import { getCategoryDef } from '@web/lib/project-categories'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { StatusBadge, CategoryBadge, cn } from '@plexo/ui'

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

const ALL_STATUSES = ['planning', 'running', 'finalizing', 'complete', 'failed', 'cancelled'] as const
const ALL_CATEGORIES = ['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general'] as const

// Module-level constant for useListFilter initialiser
const FILTER_KEYS = ['status', 'category'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        <div className="relative group/row">
            <Link
                href={`/projects/${sprint.id}`}
                className="block rounded-xl border border-border bg-surface-1/40 p-4 transition-all hover:border-azure/20 hover:bg-surface-1/70 group"
            >
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4 min-w-0">
                        <StatusBadge status={sprint.status} size="sm" className="mt-1 shrink-0" />
                        
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-semibold text-text-primary group-hover:text-azure transition-colors leading-6">
                                {sprint.request}
                            </h3>
                            <div className="mt-1 flex items-center gap-2.5 flex-wrap">
                                <CategoryBadge label={def.label} iconName={def.icon} />
                                {subtitle && (
                                    <span className="text-[10px] font-mono text-text-muted opacity-60 truncate">{subtitle}</span>
                                )}
                                <span className="text-[10px] text-zinc-600 font-mono flex items-center gap-1">
                                    <Clock className="h-2.5 w-2.5" />
                                    {formatAge(sprint.createdAt)}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                        <div className="hidden sm:flex flex-col items-end text-[10px] font-mono text-zinc-600">
                             {sprint.costUsd != null && sprint.costUsd > 0 && (
                                <span className="flex items-center gap-1 text-zinc-500">
                                    <DollarSign className="h-2.5 w-2.5" />
                                    {sprint.costUsd.toFixed(4)}
                                </span>
                             )}
                             {sprint.wallClockMs != null && sprint.wallClockMs > 0 && (
                                <span className="opacity-60">{Math.round(sprint.wallClockMs / 1000)}s</span>
                             )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-text-muted opacity-40 group-hover:opacity-100 transition-opacity" />
                    </div>
                </div>

                {sprint.totalTasks > 0 && (
                    <div className="mt-4 pt-3 border-t border-border-subtle/50">
                        <div className="flex items-baseline justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-text-secondary uppercase tracking-tight">Progress</span>
                                <span className="text-[10px] text-text-muted">{sprint.completedTasks}/{sprint.totalTasks} {def.unitPlural.toLowerCase()}</span>
                            </div>
                            <span className="text-[10px] font-bold text-azure">{pct}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-surface-2 overflow-hidden shadow-inner">
                            <div 
                                className={cn(
                                    "h-full rounded-full transition-all duration-500 ease-out",
                                    sprint.status === 'failed' ? "bg-red" : "bg-azure"
                                )}
                                style={{ width: `${pct}%` }} 
                            />
                        </div>
                        
                        {(sprint.failedTasks > 0 || sprint.conflictCount > 0) && (
                            <div className="mt-2 flex items-center gap-3">
                                {sprint.failedTasks > 0 && (
                                    <span className="text-[9px] font-bold text-red uppercase tracking-wider flex items-center gap-1">
                                        <X className="h-2.5 w-2.5" />
                                        {sprint.failedTasks} failed
                                    </span>
                                )}
                                {sprint.conflictCount > 0 && (
                                    <span className="text-[9px] font-bold text-amber uppercase tracking-wider flex items-center gap-1">
                                        <BarChart3 className="h-2.5 w-2.5" />
                                        {sprint.conflictCount} conflicts
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </Link>

            {/* Quick Actions (Floating on Hover) */}
            <div className="absolute top-3 right-8 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-all z-10">
                {['cancelled', 'failed'].includes(sprint.status) && (
                    <button
                        onClick={(e) => { e.preventDefault(); onAction('start', sprint.id) }}
                        className="p-1.5 rounded-md bg-surface-1 border border-border text-text-muted hover:text-azure hover:border-azure/30 hover:bg-azure/5 shadow-xl transition-all"
                        title="Restart project"
                    >
                        <Play className="h-3.5 w-3.5 fill-current" />
                    </button>
                )}
                {['planning', 'running', 'finalizing'].includes(sprint.status) && (
                    <button
                        onClick={(e) => { e.preventDefault(); onAction('stop', sprint.id) }}
                        className="p-1.5 rounded-md bg-surface-1 border border-border text-text-muted hover:text-amber hover:border-amber/30 hover:bg-amber/5 shadow-xl transition-all"
                        title="Stop project"
                    >
                        <Square className="h-3.5 w-3.5 fill-current" />
                    </button>
                )}
                <button
                    onClick={(e) => { e.preventDefault(); onAction('delete', sprint.id) }}
                    className="p-1.5 rounded-md bg-surface-1 border border-border text-text-muted hover:text-red hover:border-red-500/30 hover:bg-red-950/20 shadow-xl transition-all"
                    title="Delete project"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
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
    const load = useCallback(async (quiet = false) => {
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
    }, [workspaceId, apiBase])

    useEffect(() => { void load() }, [load])

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
    }, [sprints, load])

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

        // Sorting
        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            if (lf.sort === 'cost_desc') {
                return (b.costUsd ?? 0) - (a.costUsd ?? 0)
            }
            // newest
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [sprints, search, filterValues.status, filterValues.category, lf.sort])

    // ── Dimensions ────────────────────────────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'status',
            label: 'Status',
            options: ALL_STATUSES.map((s) => ({ value: s, label: s })),
        },
        {
            key: 'category',
            label: 'Category',
            options: ALL_CATEGORIES.map((c) => ({ value: c, label: c })),
        },
    ], [])

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
                    {/* Projects are usually created from Chat (CONVERSATION -> PROJECT intent) or Dashboard Quick Send */}
                </div>
            </div>

            {/* Toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search projects..."
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Highest cost', value: 'cost_desc' },
                ]}
            />

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-text-muted">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    <p className="text-sm text-text-muted">
                        {hasFilters ? 'No projects match your filters' : 'No projects yet'}
                    </p>
                    {hasFilters ? (
                        <button
                            onClick={clearAll}
                            className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto"
                        >
                            <X className="h-3.5 w-3.5" /> Clear filters
                        </button>
                    ) : (
                        <div className="mt-3 flex flex-col items-center gap-2">
                            <p className="text-xs text-text-muted max-w-sm">Projects are multi-task goals. Start one from the chat by describing a large objective, or click &ldquo;More Options&rdquo; on the home page.</p>
                            <a href="/" className="flex items-center gap-1.5 rounded-lg border border-azure/30 bg-azure/5 px-3 py-1.5 text-xs text-azure hover:bg-azure/10 transition-colors">
                                Start a project
                            </a>
                        </div>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {displayed.map((s) => (
                        <ProjectCard key={s.id} sprint={s} onAction={handleAction} />
                    ))}
                </div>
            )}
        </div>
    )
}
