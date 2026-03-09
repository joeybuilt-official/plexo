// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import {
    CheckCircle, Clock, XCircle, Loader2, RefreshCw, ChevronRight,
    FolderOpen, Plus, X, Send,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

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

const STATUS_CONFIG = {
    pending: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-400/10', label: 'Pending' },
    queued: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-400/10', label: 'Queued' },
    claimed: { icon: Loader2, color: 'text-indigo-300', bg: 'bg-indigo-300/10', label: 'Claimed' },
    running: { icon: Loader2, color: 'text-indigo-400', bg: 'bg-indigo-400/10', label: 'Running' },
    complete: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-400/10', label: 'Complete' },
    failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-400/10', label: 'Failed' },
    blocked: { icon: XCircle, color: 'text-orange-400', bg: 'bg-orange-400/10', label: 'Blocked' },
    cancelled: { icon: XCircle, color: 'text-zinc-500', bg: 'bg-zinc-500/10', label: 'Cancelled' },
} as const

const TASK_STATUSES = ['pending', 'running', 'complete', 'failed', 'blocked', 'cancelled'] as const
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
                className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="flex h-14 items-center justify-between border-b border-zinc-800 px-5">
                    <h2 className="text-sm font-semibold text-zinc-100">New task</h2>
                    <button
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-zinc-400">Description <span className="text-zinc-600">(required)</span></label>
                        <textarea
                            ref={textRef}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Describe the task the agent should execute…"
                            rows={5}
                            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 resize-none"
                        />
                        <p className="text-[10px] text-zinc-600">⌘ Enter to submit</p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-zinc-400">Type</label>
                        <div className="flex flex-wrap gap-1.5">
                            {TASK_TYPES.map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setType(t)}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${type === t ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-zinc-400">
                            Project <span className="text-zinc-600">(optional)</span>
                        </label>
                        {sprints.length === 0 ? (
                            <p className="text-xs text-zinc-600">No projects yet — create one from the Projects page.</p>
                        ) : (
                            <select
                                value={projectId}
                                onChange={(e) => setProjectId(e.target.value)}
                                className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
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
                        <p className="rounded-lg border border-red-800/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">{error}</p>
                    )}

                    <div className="mt-auto flex justify-end gap-2.5 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting || !description.trim()}
                            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                        >
                            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
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
            .catch(() => { /* ignore */ })
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
                setTasks(data.items)
            }
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [workspaceId, apiBase, filterValues.status, filterValues.type, filterValues.project])

    useEffect(() => { void load() }, [load])

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
                    <p className="mt-0.5 text-sm text-zinc-500">
                        {loading
                            ? '…'
                            : `${displayed.length}${displayed.length !== tasks.length ? ` of ${tasks.length}` : ''} task${tasks.length === 1 ? '' : 's'}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void load(true)}
                        disabled={refreshing}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors disabled:opacity-40"
                    >
                        <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                    <button
                        id="new-task-btn"
                        onClick={() => setSheetOpen(true)}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
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
                <div className="flex items-center justify-center py-16 text-zinc-600">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">
                        {hasFilters ? 'No tasks match your filters' : 'No tasks found'}
                    </p>
                    {hasFilters ? (
                        <button
                            onClick={clearAll}
                            className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mx-auto"
                        >
                            <X className="h-3.5 w-3.5" /> Clear filters
                        </button>
                    ) : (
                        <button
                            onClick={() => setSheetOpen(true)}
                            className="mt-3 flex items-center gap-1.5 rounded-lg bg-indigo-600/10 border border-indigo-800/30 px-3 py-1.5 text-xs text-indigo-400 hover:bg-indigo-600/20 transition-colors mx-auto"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Create your first task
                        </button>
                    )}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {displayed.map((task) => {
                        const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.queued
                        const Icon = cfg.icon
                        const sprint = task.projectId ? sprintMap[task.projectId] : null
                        const projectLabel = sprint ? sprintLabel(sprint) : task.project ?? null
                        return (
                            <Link
                                key={task.id}
                                href={`/tasks/${task.id}`}
                                className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5 hover:border-zinc-700 hover:bg-zinc-900/70 transition-colors group"
                            >
                                <div className="flex items-start sm:items-center gap-3 w-full sm:w-auto sm:flex-1 min-w-0">
                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 sm:mt-0 ${cfg.bg}`}>
                                        <Icon className={`h-4 w-4 ${cfg.color} ${task.status === 'running' || task.status === 'claimed' ? 'animate-spin' : ''}`} />
                                    </span>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap mb-1.5 sm:mb-0">
                                            <span className="text-xs font-mono text-zinc-500">{task.id.slice(0, 8)}</span>
                                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 capitalize">{task.type}</span>
                                            <span className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-600 hidden sm:inline-block">{task.source}</span>
                                            {projectLabel && (
                                                <span className="flex items-center gap-1 rounded bg-indigo-900/30 border border-indigo-800/30 px-1.5 py-0.5 text-[10px] text-indigo-400 max-w-[140px] sm:max-w-[180px]">
                                                    <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                                                    <span className="truncate">{projectLabel}</span>
                                                </span>
                                            )}
                                        </div>
                                        {task.outcomeSummary && (
                                            <p className="sm:mt-1 text-sm sm:text-xs text-zinc-300 sm:text-zinc-400 line-clamp-2 sm:truncate">{task.outcomeSummary}</p>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto pt-3 sm:pt-0 mt-2 sm:mt-0 border-t border-zinc-800/50 sm:border-0 sm:shrink-0 text-left sm:text-right">
                                    <div className="flex items-center gap-2">
                                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                                        {task.qualityScore !== null && (
                                            <span className={`text-[10px] font-medium hidden sm:inline-block ${task.qualityScore >= 0.8 ? 'text-emerald-400' : task.qualityScore >= 0.5 ? 'text-amber-400' : 'text-red-400'}`}>
                                                Q:{Math.round(task.qualityScore * 100)}%
                                            </span>
                                        )}
                                        {task.costUsd !== null && (
                                            <span className="text-[10px] text-zinc-600 hidden sm:inline-block">${task.costUsd.toFixed(4)}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center justify-end gap-2 text-[10px] text-zinc-600">
                                        <span>{formatAge(task.createdAt)}</span>
                                        <span>·</span>
                                        <span>{formatDur(task.createdAt, task.completedAt)}</span>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-700 group-hover:text-zinc-500 transition-colors ml-1 sm:ml-2" />
                                    </div>
                                </div>
                            </Link>
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
