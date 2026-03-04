'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import {
    CheckCircle, Clock, XCircle, Loader2, RefreshCw, ChevronRight,
    FolderOpen, Plus, X, Send,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

interface Task {
    id: string
    type: string
    status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
    source: string
    project: string | null
    projectId: string | null   // FK → sprints.id
    outcomeSummary: string | null
    qualityScore: number | null
    costUsd: number | null
    createdAt: string
    completedAt: string | null
}

interface Sprint {
    id: string
    repo: string
    request: string
    status: string
}

const STATUS_CONFIG = {
    pending: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-400/10', label: 'Pending' },
    running: { icon: Loader2, color: 'text-indigo-400', bg: 'bg-indigo-400/10', label: 'Running' },
    complete: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-400/10', label: 'Complete' },
    failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-400/10', label: 'Failed' },
    cancelled: { icon: XCircle, color: 'text-zinc-500', bg: 'bg-zinc-500/10', label: 'Cancelled' },
}

const STATUSES = ['all', 'pending', 'running', 'complete', 'failed'] as const

const TASK_TYPES = ['feature', 'bug', 'research', 'refactor', 'ops', 'other'] as const

function formatDur(created: string, completed: string | null) {
    const start = new Date(created).getTime()
    const end = completed ? new Date(completed).getTime() : Date.now()
    const s = Math.round((end - start) / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.round(s / 60)}m`
    return `${Math.round(s / 3600)}h`
}

function formatAge(iso: string) {
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.round(diff / 60000)
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
    const [type, setType] = useState<string>('feature')
    const [projectId, setProjectId] = useState<string>('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const textRef = useRef<HTMLTextAreaElement>(null)

    // Focus textarea when sheet opens
    useEffect(() => {
        if (open) {
            setTimeout(() => textRef.current?.focus(), 80)
            setDescription('')
            setType('feature')
            setProjectId('')
            setError(null)
        }
    }, [open])

    // Close on Escape
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
            const res = await fetch(`${apiBase}/api/tasks`, {
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

    // Cmd+Enter submits
    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            void handleSubmit(e as unknown as React.FormEvent)
        }
    }

    return (
        <>
            {/* Backdrop */}
            <div
                className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={onClose}
            />

            {/* Sheet */}
            <div
                className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex h-14 items-center justify-between border-b border-zinc-800 px-5">
                    <h2 className="text-sm font-semibold text-zinc-100">New task</h2>
                    <button
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
                    {/* Description */}
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

                    {/* Type */}
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

                    {/* Project (optional) */}
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
                                        {s.repo.split('/').pop()} — {s.request.slice(0, 60)}
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
    const [filter, setFilter] = useState<typeof STATUSES[number]>('all')
    const [projectFilter, setProjectFilter] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [sheetOpen, setSheetOpen] = useState(false)

    const workspaceId = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

    // Load sprints for project filter labels and task creation
    useEffect(() => {
        if (!workspaceId) return
        fetch(`${apiBase}/api/sprints?workspaceId=${workspaceId}&limit=50`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : { items: [] })
            .then((d: { items: Sprint[] }) => setSprints(d.items ?? []))
            .catch(() => { /* ignore */ })
    }, [workspaceId, apiBase])

    const load = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        else setRefreshing(true)
        try {
            const params = new URLSearchParams({ workspaceId, limit: '50' })
            if (filter !== 'all') params.set('status', filter)
            if (projectFilter && projectFilter !== 'standalone') params.set('projectId', projectFilter)
            const res = await fetch(`${apiBase}/api/tasks?${params}`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json() as { items: Task[] }
                setTasks(data.items)
            }
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [workspaceId, apiBase, filter, projectFilter])

    useEffect(() => { void load() }, [load])

    // Auto-refresh when there are running tasks
    useEffect(() => {
        if (!tasks.some((t) => t.status === 'running' || t.status === 'pending')) return
        const id = setInterval(() => void load(true), 4000)
        return () => clearInterval(id)
    }, [tasks, load])

    const sprintMap = Object.fromEntries(sprints.map((s) => [s.id, s]))

    // Tasks that have a projectId
    const projectsWithTasks = [...new Set(tasks.filter((t) => t.projectId).map((t) => t.projectId!))]
    const standaloneCount = tasks.filter((t) => !t.projectId).length

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Tasks</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">{tasks.length} tasks</p>
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

            {/* Status filter */}
            <div className="flex gap-1.5 flex-wrap">
                {STATUSES.map((s) => (
                    <button
                        key={s}
                        onClick={() => setFilter(s)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${filter === s ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
                    >
                        {s}
                    </button>
                ))}
            </div>

            {/* Project filter — only shown when there are project tasks */}
            {projectsWithTasks.length > 0 && (
                <div className="flex gap-1.5 flex-wrap items-center">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-600 mr-1">Project:</span>
                    <button
                        onClick={() => setProjectFilter(null)}
                        className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${!projectFilter ? 'bg-zinc-700 text-zinc-200' : 'border border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                    >
                        All
                    </button>
                    {standaloneCount > 0 && (
                        <button
                            onClick={() => setProjectFilter('standalone')}
                            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${projectFilter === 'standalone' ? 'bg-zinc-700 text-zinc-200' : 'border border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                        >
                            Standalone
                        </button>
                    )}
                    {projectsWithTasks.map((pid) => {
                        const sprint = sprintMap[pid]
                        const label = sprint ? sprint.repo.split('/')[1] ?? sprint.id.slice(0, 8) : pid.slice(0, 8)
                        return (
                            <button
                                key={pid}
                                onClick={() => setProjectFilter(projectFilter === pid ? null : pid)}
                                className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${projectFilter === pid ? 'bg-indigo-600/80 text-white' : 'border border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                            >
                                <FolderOpen className="h-3 w-3" />
                                {label}
                            </button>
                        )
                    })}
                </div>
            )}

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-zinc-600">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
            ) : tasks.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">No tasks found</p>
                    <button
                        onClick={() => setSheetOpen(true)}
                        className="mt-3 flex items-center gap-1.5 rounded-lg bg-indigo-600/10 border border-indigo-800/30 px-3 py-1.5 text-xs text-indigo-400 hover:bg-indigo-600/20 transition-colors mx-auto"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Create your first task
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {tasks
                        .filter((t) => {
                            if (projectFilter === 'standalone') return !t.projectId
                            if (projectFilter) return t.projectId === projectFilter
                            return true
                        })
                        .map((task) => {
                            const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending
                            const Icon = cfg.icon
                            const sprint = task.projectId ? sprintMap[task.projectId] : null
                            const projectLabel = sprint
                                ? sprint.repo.split('/')[1] ?? sprint.id.slice(0, 8)
                                : task.project ?? null
                            return (
                                <Link
                                    key={task.id}
                                    href={`/tasks/${task.id}`}
                                    className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5 hover:border-zinc-700 hover:bg-zinc-900/70 transition-colors group"
                                >
                                    {/* Status icon */}
                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cfg.bg}`}>
                                        <Icon className={`h-4 w-4 ${cfg.color} ${task.status === 'running' ? 'animate-spin' : ''}`} />
                                    </span>

                                    {/* Main */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-xs font-mono text-zinc-500">{task.id.slice(0, 8)}</span>
                                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 capitalize">{task.type}</span>
                                            <span className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-600">{task.source}</span>
                                            {projectLabel && (
                                                <span className="flex items-center gap-1 rounded bg-indigo-900/30 border border-indigo-800/30 px-1.5 py-0.5 text-[10px] text-indigo-400">
                                                    <FolderOpen className="h-2.5 w-2.5" />
                                                    {projectLabel}
                                                </span>
                                            )}
                                        </div>
                                        {task.outcomeSummary && (
                                            <p className="mt-1 text-xs text-zinc-400 truncate">{task.outcomeSummary}</p>
                                        )}
                                    </div>

                                    {/* Meta */}
                                    <div className="shrink-0 text-right">
                                        <div className="flex items-center gap-2">
                                            {task.qualityScore !== null && (
                                                <span className={`text-[10px] font-medium ${task.qualityScore >= 0.8 ? 'text-emerald-400' : task.qualityScore >= 0.5 ? 'text-amber-400' : 'text-red-400'}`}>
                                                    Q:{Math.round(task.qualityScore * 100)}%
                                                </span>
                                            )}
                                            {task.costUsd !== null && (
                                                <span className="text-[10px] text-zinc-600">${task.costUsd.toFixed(4)}</span>
                                            )}
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                                        </div>
                                        <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-zinc-600">
                                            <span>{formatAge(task.createdAt)}</span>
                                            <span>·</span>
                                            <span>{formatDur(task.createdAt, task.completedAt)}</span>
                                        </div>
                                    </div>

                                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
                                </Link>
                            )
                        })}
                </div>
            )}

            {/* New Task Sheet */}
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
