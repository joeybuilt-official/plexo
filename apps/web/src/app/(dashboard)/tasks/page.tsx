// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import {
    FolderOpen, Plus, X, Trash2, StopCircle, RefreshCw, ChevronRight, Loader2
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { StatusBadge, cn } from '@plexo/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
    id: string
    type: string
    status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled' | 'queued' | 'claimed' | 'blocked'
    source: string
    project: string | null
    projectId: string | null
    outcomeSummary: string | null
    qualityScore: number | null
    costUsd: number | null
    createdAt: string
    completedAt: string | null
}

interface Sprint {
    id: string
    repo: string | null
    request: string
    status: string
    category: string
}

// ── Config ────────────────────────────────────────────────────────────────────

const TASK_STATUSES = ['pending', 'queued', 'claimed', 'running', 'complete', 'failed', 'blocked', 'cancelled'] as const
const TASK_TYPES = ['coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring', 'report', 'online', 'automation'] as const

// Module-level constant → stable reference for useListFilter initialiser
const FILTER_KEYS = ['status', 'type', 'project'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function sprintLabel(s: Sprint): string {
    if (s.repo) {
        const parts = s.repo.split('/')
        return parts[parts.length - 1] ?? s.id.slice(0, 8)
    }
    return s.request.slice(0, 36) + (s.request.length > 36 ? '…' : '')
}

function formatDur(created: string, completed: string | null) {
    const s = Math.round(((completed ? new Date(completed).getTime() : Date.now()) - new Date(created).getTime()) / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.round(s / 60)}m`
    return `${Math.round(s / 3600)}h`
}

function formatAge(iso: string) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
}

// ── New Task Sheet ─────────────────────────────────────────────────────────────

interface NewTaskSheetProps {
    open: boolean
    onClose: () => void
    onCreated: () => void
    sprints: Sprint[]
    workspaceId: string
    apiBase: string
}

function NewTaskSheet({ open, onClose, onCreated, sprints, workspaceId, apiBase }: NewTaskSheetProps) {
    const [description, setDescription] = useState('')
    const [type, setType] = useState<string>('research')
    const [projectId, setProjectId] = useState<string>('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const textRef = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        if (open) {
            setTimeout(() => textRef.current?.focus(), 80)
            setDescription('')
            setType('research')
            setProjectId('')
            setError(null)
        }
    }, [open])

    useEffect(() => {
        if (!open) return
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [open, onClose])

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        if (!description.trim()) return
        setSubmitting(true)
        setError(null)
        try {
            const body: Record<string, unknown> = {
                workspaceId,
                type,
                description: description.trim(),
                source: 'dashboard',
            }
            if (projectId) body.projectId = projectId
            const res = await fetch(`${apiBase}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!res.ok) {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Failed to create task')
                return
            }
            onCreated()
            onClose()
        } catch {
            setError('Network error — task not created')
        } finally {
            setSubmitting(false)
        }
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            void handleSubmit(e as unknown as React.FormEvent)
        }
    }

    return (
        <>
            <div
                className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={onClose}
            />
            <div
                className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-canvas shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="flex h-14 items-center justify-between border-b border-border px-5">
                    <h2 className="text-sm font-semibold text-text-primary">New task</h2>
                    <button
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text-secondary transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary">Description <span className="text-text-muted">(required)</span></label>
                        <textarea
                            ref={textRef}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Describe the task the agent should execute…"
                            rows={5}
                            className="rounded-xl border border-border bg-surface-1 px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 resize-none"
                        />
                        <p className="text-[10px] text-text-muted">⌘ Enter to submit</p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary">Type</label>
                        <div className="flex flex-wrap gap-1.5">
                            {TASK_TYPES.map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setType(t)}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${type === t ? 'bg-azure text-white' : 'border border-border text-text-secondary hover:border-zinc-600 hover:text-text-primary'}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary">
                            Project <span className="text-text-muted">(optional)</span>
                        </label>
                        {sprints.length === 0 ? (
                            <p className="text-xs text-text-muted">No projects yet — create one from the Projects page.</p>
                        ) : (
                            <select
                                value={projectId}
                                onChange={(e) => setProjectId(e.target.value)}
                                className="rounded-xl border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus:outline-none"
                            >
                                <option value="">— No project (standalone) —</option>
                                {sprints.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {sprintLabel(s)}
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>

                    {error && (
                        <p className="rounded-lg border border-red-800/40 bg-red-950/30 px-3 py-2 text-xs text-red">{error}</p>
                    )}

                    <div className="mt-auto flex justify-end gap-2.5 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting || !description.trim()}
                            className="flex items-center gap-2 rounded-lg bg-azure px-4 py-2 text-sm font-medium text-white hover:bg-azure/90 disabled:opacity-50 transition-colors"
                        >
                            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                            Create task
                        </button>
                    </div>
                </form>
            </div>
        </>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TasksPage() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const [tasks, setTasks] = useState<Task[]>([])
    const [sprints, setSprints] = useState<Sprint[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [sheetOpen, setSheetOpen] = useState(false)

    const workspaceId = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    // ── Filter state (shared standard) ────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters, clearAll } = lf

    // ── Load sprints ──────────────────────────────────────────────────────────
    useEffect(() => {
        if (!workspaceId) return
        fetch(`${apiBase}/api/v1/sprints?workspaceId=${workspaceId}&limit=100`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : { items: [] })
            .then((d: { items: Sprint[] }) => setSprints(d.items ?? []))
            .catch(() => { /* sprints sidebar is non-critical */ })
    }, [workspaceId, apiBase])

    // ── Load tasks (server-side filters: status, type, projectId) ─────────────
    const load = useCallback(async (quiet = false) => {
        if (!workspaceId) return
        if (!quiet) setLoading(true)
        else setRefreshing(true)
        try {
            const params = new URLSearchParams({ workspaceId, limit: '100' })
            if (filterValues.status) params.set('status', filterValues.status)
            if (filterValues.type) params.set('type', filterValues.type)
            if (filterValues.project && filterValues.project !== 'standalone')
                params.set('projectId', filterValues.project)
            const res = await fetch(`${apiBase}/api/v1/tasks?${params}`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json() as { items: Task[] }
                setTasks(data.items ?? [])
            }
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [workspaceId, apiBase, filterValues.status, filterValues.type, filterValues.project])

    useEffect(() => { void load() }, [load])

    const cancelTask = useCallback(async (taskId: string, e?: React.MouseEvent) => {
        if (e) {
            e.preventDefault()
            e.stopPropagation()
        }
        try {
            await fetch(`${apiBase}/api/v1/tasks/${taskId}`, { method: 'DELETE' })
            void load(true)
        } catch { /* best-effort cancel; list refreshes on next poll */ }
    }, [apiBase, load])

    // Auto-refresh while active tasks exist
    useEffect(() => {
        if (!tasks.some((t) => t.status === 'running' || t.status === 'queued' || t.status === 'claimed')) return
        const id = setInterval(() => void load(true), 4000)
        return () => clearInterval(id)
    }, [tasks, load])

    // ── Derived data ──────────────────────────────────────────────────────────
    const sprintMap = useMemo(() => Object.fromEntries(sprints.map((s) => [s.id, s])), [sprints])

    // Client-side: standalone filter + text search + sort
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = tasks
        if (filterValues.project === 'standalone') {
            result = result.filter((t) => !t.projectId)
        }
        if (q) {
            result = result.filter((t) =>
                t.id.toLowerCase().includes(q) ||
                t.type.toLowerCase().includes(q) ||
                t.source.toLowerCase().includes(q) ||
                (t.outcomeSummary?.toLowerCase().includes(q) ?? false) ||
                (t.project?.toLowerCase().includes(q) ?? false) ||
                (t.projectId
                    ? (sprintMap[t.projectId] ? sprintLabel(sprintMap[t.projectId]).toLowerCase().includes(q) : false)
                    : false),
            )
        }

        // Sorting
        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            if (lf.sort === 'quality_desc') {
                return (b.qualityScore ?? -1) - (a.qualityScore ?? -1)
            }
            if (lf.sort === 'cost_desc') {
                return (b.costUsd ?? 0) - (a.costUsd ?? 0)
            }
            // default 'newest'
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [tasks, search, filterValues.project, sprintMap, lf.sort])

    // Available task types from loaded set (used to dim non-present options)
    const availableTypes = useMemo(() => new Set(tasks.map((t) => t.type)), [tasks])

    // ── Filter dimensions for the toolbar ─────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'status',
            label: 'Status',
            options: TASK_STATUSES.map((s) => ({ value: s, label: s })),
        },
        {
            key: 'type',
            label: 'Type',
            options: TASK_TYPES.map((t) => ({
                value: t,
                label: t,
                dimmed: !availableTypes.has(t),
            })),
        },
        {
            key: 'project',
            label: 'Project',
            options: [
                { value: 'standalone', label: 'Standalone' },
                ...sprints.map((s) => ({
                    value: s.id,
                    label: sprintLabel(s),
                    icon: <FolderOpen className="h-3 w-3 shrink-0" />,
                })),
            ],
        },
    ], [availableTypes, sprints])

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Tasks</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {loading
                            ? '…'
                            : `${displayed.length}${displayed.length !== tasks.length ? ` of ${tasks.length}` : ''} task${tasks.length === 1 ? '' : 's'}`}
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
                    <button
                        id="new-task-btn"
                        onClick={() => setSheetOpen(true)}
                        className="flex items-center gap-1.5 rounded-lg bg-azure px-3 py-1.5 text-xs font-medium text-white hover:bg-azure/90 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New task
                    </button>
                </div>
            </div>

            {/* Search + filter + sort toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by ID, type, source, or outcome…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Highest quality', value: 'quality_desc' },
                    { label: 'Highest cost', value: 'cost_desc' },
                ]}
            />

            {/* Task list */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-text-muted">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-16 text-center">
                    {hasFilters ? (
                        <>
                            <p className="text-sm text-text-muted">No tasks match your filters</p>
                            <button
                                onClick={clearAll}
                                className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto"
                            >
                                <X className="h-3.5 w-3.5" /> Clear filters
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="text-sm text-text-primary font-medium">Run a task and its results appear here</p>
                            <p className="mt-1 text-xs text-text-muted">Tasks are how your agent gets work done.</p>
                            <button
                                onClick={() => setSheetOpen(true)}
                                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-azure px-4 py-2 text-xs font-medium text-white hover:bg-azure/90 transition-colors"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                New Task
                            </button>
                        </>
                    )}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {displayed.map((task) => {
                        const sprint = task.projectId ? sprintMap[task.projectId] : null
                        const projectLabel = sprint ? sprintLabel(sprint) : task.project ?? null
                        const isCancellable = ['running', 'queued', 'claimed', 'pending'].includes(task.status)
                        
                        return (
                            <div key={task.id} className="relative group/row">
                                <Link
                                    href={`/tasks/${task.id}`}
                                    className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 rounded-xl border border-border bg-surface-1/40 px-4 py-3.5 hover:border-azure/20 hover:bg-surface-1/70 transition-all group"
                                >
                                    <div className="flex items-start sm:items-center gap-4 flex-1 min-w-0">
                                        <StatusBadge status={task.status} size="sm" className="mt-0.5 sm:mt-0 shrink-0" />

                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap mb-1">
                                                <span className="text-[10px] font-mono text-text-muted opacity-40 group-hover:opacity-100 transition-opacity">#{task.id.slice(0, 8)}</span>
                                                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold text-text-secondary uppercase tracking-tight">{task.type}</span>
                                                <span className="rounded bg-surface-2/50 px-1.5 py-0.5 text-[9px] text-text-muted opacity-60 hidden sm:inline-block uppercase tracking-tight">{task.source}</span>
                                                {projectLabel && (
                                                    <span className="flex items-center gap-1 rounded bg-azure/5 border border-azure/10 px-1.5 py-0.5 text-[10px] text-azure/80 max-w-[140px] sm:max-w-[180px]">
                                                        <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                                                        <span className="truncate">{projectLabel}</span>
                                                    </span>
                                                )}
                                            </div>
                                            <p className="truncate text-sm font-medium text-text-primary group-hover:text-azure transition-colors leading-normal">
                                                {task.outcomeSummary ? task.outcomeSummary : 'Task in progress...'}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between sm:justify-end gap-5 w-full sm:w-auto pt-2 sm:pt-0">
                                        <div className="flex flex-col items-start sm:items-end text-[10px] text-zinc-600 font-mono">
                                            <div className="flex items-center gap-2">
                                                <span>{formatAge(task.createdAt)}</span>
                                                <span className="text-zinc-800">·</span>
                                                <span>{formatDur(task.createdAt, task.completedAt)}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {task.qualityScore != null && (
                                                    <span className={cn(
                                                        "font-medium",
                                                        task.qualityScore >= 0.8 ? "text-azure" : task.qualityScore >= 0.5 ? "text-amber" : "text-red"
                                                    )}>
                                                        Q:{Math.round(task.qualityScore * 100)}%
                                                    </span>
                                                )}
                                                {task.costUsd != null && task.costUsd > 0 && (
                                                    <span className="text-zinc-700 font-medium">${task.costUsd.toFixed(4)}</span>
                                                )}
                                            </div>
                                        </div>
                                        
                                        <div className="flex items-center gap-1 text-text-muted">
                                            <ChevronRight className="h-4 w-4" />
                                        </div>
                                    </div>
                                </Link>

                                {/* Action buttons overlaid on hover */}
                                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-all z-10">
                                    {isCancellable && (
                                        <button
                                            onClick={(e) => cancelTask(task.id, e)}
                                            className="p-1.5 rounded-md bg-surface-1 border border-border text-text-muted hover:text-red hover:border-red-500/30 hover:bg-red-950/20 shadow-xl transition-all"
                                            title="Cancel task"
                                        >
                                            <StopCircle className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            <NewTaskSheet
                open={sheetOpen}
                onClose={() => setSheetOpen(false)}
                onCreated={() => void load(true)}
                sprints={sprints}
                workspaceId={workspaceId}
                apiBase={apiBase}
            />
        </div>
    )
}
