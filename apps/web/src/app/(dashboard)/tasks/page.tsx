'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { CheckCircle, Clock, XCircle, Loader2, RefreshCw, ChevronRight, FolderOpen } from 'lucide-react'

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

export default function TasksPage() {
    const [tasks, setTasks] = useState<Task[]>([])
    const [sprints, setSprints] = useState<Sprint[]>([])
    const [filter, setFilter] = useState<typeof STATUSES[number]>('all')
    const [projectFilter, setProjectFilter] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

    // Load sprints for project filter labels
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
            if (projectFilter) params.set('projectId', projectFilter)
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

    // Tasks that have a projectId which isn't in sprints list — show raw id
    const projectsWithTasks = [...new Set(tasks.filter((t) => t.projectId).map((t) => t.projectId!))]

    const standaloneCount = tasks.filter((t) => !t.projectId).length

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Tasks</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">{tasks.length} tasks</p>
                </div>
                <button
                    onClick={() => void load(true)}
                    disabled={refreshing}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
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
                    <p className="mt-1 text-xs text-zinc-600">Submit one from the dashboard to get started.</p>
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
        </div>
    )
}
