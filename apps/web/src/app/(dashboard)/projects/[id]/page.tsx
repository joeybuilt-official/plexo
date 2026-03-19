// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
    GitBranch,
    Zap,
    CheckCircle2,
    XCircle,
    Clock,
    AlertTriangle,
    RefreshCw,
    ArrowLeft,
    DollarSign,
    TrendingUp,
    ExternalLink,
    Terminal,
    ChevronDown,
    FileText,
    ChevronRight,
    StopCircle,
    Settings,
    LayoutGrid,
    CheckCheck,
    GitPullRequest,
    BadgeDollarSign,
    Sparkles,
    Cpu,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { getCategoryDef } from '@web/lib/project-categories'
import { cn, StatusBadge, CategoryBadge } from '@plexo/ui'

const formatAge = (date: string | null) => {
    if (!date) return 'N/A'
    const d = new Date(date)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SprintTaskItem {
    id: string
    description: string
    scope: string[]
    acceptance: string
    branch: string
    priority: number
    status: 'queued' | 'running' | 'complete' | 'blocked' | 'failed' | 'pending' | 'claimed' | 'cancelled'
    handoff: { prNumber?: number; prUrl?: string; taskId?: string } | null
    createdAt: string
    completedAt: string | null
}

interface SprintDetail {
    sprint: {
        id: string
        repo: string | null
        category: string
        request: string
        status: string
        totalTasks: number
        completedTasks: number
        failedTasks: number
        conflictCount: number
        qualityScore: number | null
        totalTokens: number | null
        costUsd: number | null
        wallClockMs: number | null
        plannerIterations: number
        featuresCompleted: string[]
        metadata: Record<string, unknown>
        createdAt: string
        completedAt: string | null
    }
    tasks: SprintTaskItem[]
}

type SprintLogLevel = 'info' | 'warn' | 'error'
type SprintLogEvent =
    | 'planning_start' | 'planning_complete'
    | 'wave_start' | 'wave_complete'
    | 'task_queued' | 'task_running' | 'task_complete' | 'task_failed' | 'task_timeout'
    | 'pr_created' | 'pr_failed' | 'pr_skipped'
    | 'conflict_detected' | 'budget_check' | 'budget_ceiling_hit'
    | 'sprint_complete' | 'sprint_failed' | 'sprint_cancelled'
    | 'branch_created' | 'branch_failed'
    | 'routing_trace' | 'quality_forecast'

interface SprintLogEntry {
    id: string
    sprintId: string
    level: SprintLogLevel
    event: SprintLogEvent
    message: string
    metadata: Record<string, unknown>
    createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const LEVEL_COLORS: Record<SprintLogLevel, string> = {
    info: 'text-text-muted',
    warn: 'text-amber',
    error: 'text-red',
}

const LOG_EVENT_CONFIG: Record<string, { label: string; icon: LucideIcon; color: string; bgColor: string }> = {
    planning_start: { label: 'Planning', icon: Zap, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
    planning_complete: { label: 'Ready', icon: CheckCircle2, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
    wave_start: { label: 'Wave Start', icon: TrendingUp, color: 'text-azure', bgColor: 'bg-azure-dim/20' },
    wave_complete: { label: 'Wave OK', icon: CheckCheck, color: 'text-azure', bgColor: 'bg-azure-dim/20' },
    task_queued: { label: 'Queued', icon: Clock, color: 'text-text-muted', bgColor: 'bg-surface-2/40' },
    task_running: { label: 'Working', icon: RefreshCw, color: 'text-azure', bgColor: 'bg-azure-dim/30' },
    task_complete: { label: 'Task OK', icon: CheckCheck, color: 'text-azure', bgColor: 'bg-azure-dim/30' },
    task_failed: { label: 'Task Fail', icon: XCircle, color: 'text-red', bgColor: 'bg-red-500/10' },
    task_timeout: { label: 'Timeout', icon: Clock, color: 'text-red', bgColor: 'bg-red-500/10' },
    pr_created: { label: 'PR Split', icon: GitPullRequest, color: 'text-azure', bgColor: 'bg-azure-dim/20' },
    pr_failed: { label: 'PR Fail', icon: XCircle, color: 'text-red', bgColor: 'bg-red-500/10' },
    budget_check: { label: 'Budget', icon: BadgeDollarSign, color: 'text-text-muted', bgColor: 'bg-surface-2/40' },
    budget_ceiling_hit: { label: 'Ceiling', icon: AlertTriangle, color: 'text-red', bgColor: 'bg-red-500/10' },
    conflict_detected: { label: 'Conflict', icon: AlertTriangle, color: 'text-amber', bgColor: 'bg-amber-dim/50' },
    sprint_complete: { label: 'Success', icon: CheckCircle2, color: 'text-azure', bgColor: 'bg-azure-dim/20' },
    sprint_failed: { label: 'Failed', icon: XCircle, color: 'text-red', bgColor: 'bg-red-500/10' },
    branch_created: { label: 'Branch', icon: GitBranch, color: 'text-text-muted', bgColor: 'bg-surface-2/20' },
    quality_forecast: { label: 'Forecast', icon: Sparkles, color: 'text-amber', bgColor: 'bg-amber-dim/20' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms: number | null) {
    if (ms == null || ms < 0) return '—'
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function timeAgo(iso: string) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WorkerCard({ task }: { task: SprintTaskItem }) {
    const isRunning = task.status === 'running'
    return (
        <Link
            href={`/tasks/${task.id}`}
            className={cn(
                "group flex flex-col justify-between rounded-xl border p-3.5 transition-all",
                isRunning 
                    ? "border-azure/30 bg-azure-dim/10 shadow-[0_0_15px_-5px_var(--color-azure)]" 
                    : "border-border bg-surface-1/40 hover:border-border-hover"
            )}
        >
            <div>
                <div className="flex items-center justify-between mb-2.5">
                    <StatusBadge status={task.status} size="sm" />
                    <span className="text-[10px] font-mono text-text-muted opacity-40 group-hover:opacity-100 transition-opacity">#{task.id.slice(0, 8)}</span>
                </div>
                <p className="text-sm font-medium text-text-primary line-clamp-2 leading-snug mb-3 min-h-[2.8em]">
                    {task.description}
                </p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                    {task.scope.slice(0, 3).map((s) => (
                        <span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-mono text-text-secondary border border-border/50 truncate max-w-[100px]">{s}</span>
                    ))}
                    {task.scope.length > 3 && (
                        <span className="text-[9px] text-text-muted">+{task.scope.length - 3}</span>
                    )}
                </div>
            </div>
            
            <div className="flex items-center justify-between mt-auto pt-3 border-t border-border-subtle/30">
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted">
                    <GitBranch className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate max-w-[80px]">{task.branch}</span>
                </div>
                {task.completedAt && (
                    <span className="text-[10px] text-text-muted">{timeAgo(task.completedAt)}</span>
                )}
            </div>
        </Link>
    )
}

function LogEntry({ entry, isNew }: { entry: SprintLogEntry; isNew?: boolean }) {
    const cfg = LOG_EVENT_CONFIG[entry.event] ?? LOG_EVENT_CONFIG.task_running
    const Icon = cfg.icon
    const [expanded, setExpanded] = useState(false)
    const hasMetadata = Object.keys(entry.metadata ?? {}).length > 0 &&
        !(['budget_check'].includes(entry.event) && Object.keys(entry.metadata).length <= 2)

    return (
        <div
            className={cn(
                "group flex gap-3 px-3 py-2.5 rounded-lg border transition-all duration-300",
                cfg.bgColor,
                isNew ? "animate-[fadeSlideIn_0.3s_ease-out]" : ""
            )}
        >
            <div className={`shrink-0 mt-0.5 ${cfg.color}`}>
                <Icon className="h-3.5 w-3.5" />
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.color} opacity-70`}>
                            {cfg.label}
                        </span>
                        <p className="text-xs text-text-secondary leading-relaxed">{entry.message}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-mono ${LEVEL_COLORS[entry.level]}`}>
                            {entry.level !== 'info' ? entry.level.toUpperCase() : ''}
                        </span>
                        <span className="text-[10px] font-mono text-text-muted tabular-nums">
                            {formatTime(entry.createdAt)}
                        </span>
                        {hasMetadata && (
                            <button
                                onClick={() => setExpanded(!expanded)}
                                className="text-text-muted hover:text-text-secondary transition-colors"
                            >
                                <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
                            </button>
                        )}
                    </div>
                </div>

                {expanded && hasMetadata && (
                    <div className="mt-2 rounded bg-black/30 border border-border-subtle p-2">
                        <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap overflow-x-auto max-h-40">
                            {JSON.stringify(entry.metadata, null, 2)}
                        </pre>
                    </div>
                )}

                {(entry.metadata?.branch as string) && !expanded && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-text-muted">
                        <GitBranch className="h-2.5 w-2.5" />
                        {entry.metadata.branch as string}
                    </div>
                )}
            </div>
        </div>
    )
}

function ActivityLog({ sprintId, isActive }: { sprintId: string; isActive: boolean }) {
    const [entries, setEntries] = useState<SprintLogEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [connected, setConnected] = useState(false)
    const logEndRef = useRef<HTMLDivElement>(null)
    const lastIdRef = useRef<string | null>(null)

    const fetchLogs = useCallback(async () => {
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/logs?limit=250`, { cache: 'no-store' })
            if (res.ok) {
                const logs = await res.json() as SprintLogEntry[]
                setEntries(logs)
                if (logs.length > 0) lastIdRef.current = logs[logs.length - 1].id
            }
        } catch { setError(true) } finally { setLoading(false) }
    }, [sprintId])

    useEffect(() => { void fetchLogs() }, [fetchLogs])

    useEffect(() => {
        if (!isActive) return
        const es = new EventSource(`${API}/api/v1/sprints/${sprintId}/logs/sse`)
        es.onopen = () => setConnected(true)
        es.onerror = () => setConnected(false)
        es.onmessage = (e) => {
            try {
                const entry = JSON.parse(e.data) as SprintLogEntry
                if (entry.id !== lastIdRef.current) {
                    setEntries((prev) => [...prev, entry])
                    lastIdRef.current = entry.id
                }
            } catch { /* skip */ }
        }
        return () => { es.close(); setConnected(false) }
    }, [sprintId, isActive])

    useEffect(() => {
        if (connected) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [entries, connected])

    return (
        <div className="flex flex-col gap-2 max-h-[70vh] min-h-[400px]">
            <div className="flex items-center justify-between px-1 mb-1">
                <div className="flex items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 rounded-full shadow-[0_0_5px_var(--color-azure)]", connected ? "bg-azure" : "bg-text-muted")} />
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">{connected ? 'Live Trace' : 'Trace Offline'}</span>
                </div>
                {connected && <span className="text-[10px] text-zinc-600 font-mono animate-pulse">UPDATING…</span>}
            </div>
            
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {loading ? (
                    <div className="py-20 text-center text-xs text-text-muted">Analyzing log stream…</div>
                ) : entries.length === 0 ? (
                    <div className="py-20 text-center text-xs text-text-muted">No activity recorded yet for this operation.</div>
                ) : (
                    <div className="flex flex-col gap-1.5 pb-4">
                        {entries.map((entry, i) => (
                            <LogEntry key={entry.id} entry={entry} isNew={i === entries.length - 1 && connected} />
                        ))}
                        <div ref={logEndRef} />
                    </div>
                )}
            </div>
        </div>
    )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SprintDetailPage() {
    const params = useParams<{ id: string }>()
    const router = useRouter()
    const sprintId = params.id
    const [data, setData] = useState<SprintDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)
    const [elapsedMs, setElapsedMs] = useState(0)
    const [tab, setTab] = useState<'workers' | 'tasks' | 'features' | 'deliverables' | 'log'>('workers')
    const [deliverables, setDeliverables] = useState<Array<{ taskId: string; filename: string; bytes: number; isText: boolean; content: string | null }>>([])
    const [delivLoading, setDelivLoading] = useState(false)
    const [delivLoaded, setDelivLoaded] = useState(false)
    const [openDeliv, setOpenDeliv] = useState<string | null>(null)
    const [stopping, setStopping] = useState(false)
    const [retrying, setRetrying] = useState(false)
    const esRef = useRef<EventSource | null>(null)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const tabInitializedRef = useRef(false)

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/tasks`, { cache: 'no-store' })
            if (res.status === 404) { setNotFound(true); return }
            if (!res.ok) return
            const d = await res.json() as SprintDetail
            setData(d)

            // Category-aware default tab logic
            if (!tabInitializedRef.current) {
                const category = d.sprint.category;
                if (['writing', 'report'].includes(category)) {
                    setTab('deliverables');
                }
                tabInitializedRef.current = true;
            }
        } catch { /* fetch may fail if server restarts mid-load */ } finally {
            setLoading(false)
        }
    }, [sprintId])

    const loadDeliverables = useCallback(async () => {
        if (delivLoaded || delivLoading) return
        setDelivLoading(true)
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/tasks`, { cache: 'no-store' })
            if (!res.ok) return
            const d = await res.json() as SprintDetail
            const doneTasks = d.tasks.filter((t) => t.status === 'complete' && t.handoff?.taskId)
            const results: Array<{ taskId: string; filename: string; bytes: number; isText: boolean; content: string | null }> = []
            await Promise.all(
                doneTasks.map(async (t) => {
                    const tid = t.handoff!.taskId!
                    try {
                        const ar = await fetch(`${API}/api/v1/tasks/${tid}/assets`)
                        if (!ar.ok) return
                        const ad = await ar.json() as { items: Array<{ filename: string; bytes: number; isText: boolean; content: string | null }> }
                        for (const item of ad.items ?? []) {
                            results.push({ taskId: tid, ...item })
                        }
                    } catch { /* skip */ }
                })
            )
            setDeliverables(results)
            setDelivLoaded(true)
        } finally {
            setDelivLoading(false)
        }
    }, [sprintId, delivLoaded, delivLoading])

    useEffect(() => {
        if (tab === 'deliverables') void loadDeliverables()
    }, [tab, loadDeliverables])

    async function handleStop() {
        if (!confirm('Stop this project? All running and queued tasks will be cancelled.')) return
        setStopping(true)
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}`, { method: 'DELETE' })
            if (res.ok) {
                await fetchData()
            }
        } finally {
            setStopping(false)
        }
    }

    async function handleRetry() {
        setRetrying(true)
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/retry`, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: `sprint-${sprintId}` }) 
            })
            if (res.ok) {
                await fetchData()
            } else {
                alert('Failed to start retry')
            }
        } finally {
            setRetrying(false)
        }
    }

    useEffect(() => { void fetchData() }, [fetchData])

    useEffect(() => {
        if (!data) return
        const isActive = ['planning', 'running', 'finalizing'].includes(data.sprint.status)
        if (isActive && !esRef.current) {
            const es = new EventSource(`${API}/api/v1/sprints/${sprintId}/tasks/sse`)
            es.onmessage = (e) => {
                try {
                    const update = JSON.parse(e.data) as SprintDetail
                    setData(update)
                } catch { /* skip */ }
            }
            esRef.current = es
        }
        if (!isActive && esRef.current) {
            esRef.current.close()
            esRef.current = null
        }
        return () => { esRef.current?.close(); esRef.current = null }
    }, [data, sprintId])

    useEffect(() => {
        if (!data) return
        const isActive = ['planning', 'running', 'finalizing'].includes(data.sprint.status)
        if (isActive) {
            const start = new Date(data.sprint.createdAt).getTime()
            timerRef.current = setInterval(() => setElapsedMs(Date.now() - start), 100)
        } else {
            if (timerRef.current) clearInterval(timerRef.current)
            timerRef.current = null
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current) }
    }, [data])

    if (notFound) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
                <div className="rounded-full bg-surface-2 p-4 text-text-muted">
                    <AlertTriangle className="h-10 w-10" />
                </div>
                <h2 className="text-xl font-bold text-text-primary">Project Not Found</h2>
                <p className="text-text-muted">The project you are looking for does not exist or has been deleted.</p>
                <Link href="/projects" className="mt-4 text-azure hover:underline">Return to Projects</Link>
            </div>
        )
    }

    if (loading || !data) {
        return (
            <div className="flex items-center justify-center py-32 text-text-muted">
                <RefreshCw className="h-6 w-6 animate-spin mr-3" />
                Initializing control room…
            </div>
        )
    }

    const { sprint, tasks } = data
    const def = getCategoryDef(sprint.category)
    const isCode = sprint.category === 'code'
    const isActive = ['planning', 'running', 'finalizing'].includes(sprint.status)
    const progressPct = sprint.totalTasks > 0 ? Math.round((sprint.completedTasks / sprint.totalTasks) * 100) : 0
    const throughput = (sprint.wallClockMs ?? elapsedMs) > 60000 
        ? (sprint.completedTasks / ((sprint.wallClockMs ?? elapsedMs) / 60000)).toFixed(1) 
        : null
    const runningTasks = tasks.filter((t) => t.status === 'running')

    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500">
            {/* Nav & Header */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4 min-w-0">
                    <button
                        onClick={() => router.back()}
                        className="rounded-lg border border-border bg-surface-1 p-2 text-text-muted hover:bg-surface-2 transition-colors shrink-0"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0">
                         <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono text-zinc-600 opacity-60">PROJ_{sprint.id.slice(0, 8)}</span>
                            <span className="text-zinc-800 text-[10px]">/</span>
                            <span className="text-[10px] font-mono text-text-muted opacity-60">{formatAge(sprint.createdAt)}</span>
                        </div>
                        <h1 className="truncate text-xl font-bold text-zinc-50 tracking-tight">{sprint.request}</h1>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <StatusBadge status={sprint.status} />
                    <CategoryBadge label={def.label} iconName={def.icon} />
                </div>
            </div>

            {/* Actions Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-surface-1/30">
                 <div className="flex items-center gap-3">
                    {sprint.repo && (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-xs font-mono text-text-secondary">
                            <GitBranch className="h-3.5 w-3.5" />
                            {sprint.repo}
                        </div>
                    )}
                 </div>
                 <div className="flex items-center gap-2">
                    {sprint.status === 'failed' && (
                        <button
                            onClick={() => void handleRetry()}
                            disabled={retrying}
                            className="flex items-center gap-1.5 rounded-lg bg-azure px-4 py-1.5 text-xs font-medium text-white hover:bg-azure/90 transition-all disabled:opacity-40"
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
                            {retrying ? 'Retrying…' : 'Retry Project'}
                        </button>
                    )}
                    {isActive && (
                        <button
                            onClick={() => void handleStop()}
                            disabled={stopping}
                            className="flex items-center gap-1.5 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-1.5 text-xs text-red hover:bg-red-900/40 transition-all disabled:opacity-40"
                        >
                            <StopCircle className="h-3.5 w-3.5" />
                            {stopping ? 'Stopping…' : 'Stop project'}
                        </button>
                    )}
                    <button
                        onClick={() => void fetchData()}
                        className="rounded-lg border border-border bg-surface-1 p-2 text-text-muted hover:bg-surface-2 transition-colors"
                        aria-label="Refresh"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", isActive && "animate-spin")} />
                    </button>
                </div>
            </div>

            {/* Metrics Row */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                 {[
                    { icon: CheckCircle2, label: 'Complete', value: sprint.completedTasks, sub: `of ${sprint.totalTasks}`, color: 'text-azure' },
                    { icon: XCircle, label: 'Failed', value: sprint.failedTasks, sub: 'tasks', color: sprint.failedTasks > 0 ? 'text-red' : 'text-zinc-600' },
                    { icon: AlertTriangle, label: 'Conflicts', value: sprint.conflictCount, sub: 'merges', color: sprint.conflictCount > 0 ? 'text-amber' : 'text-zinc-600' },
                    { icon: Clock, label: 'Elapsed', value: formatMs(isActive ? elapsedMs : sprint.wallClockMs), sub: isActive ? 'running' : 'finalized', color: 'text-text-secondary' },
                    { icon: DollarSign, label: 'Cost', value: sprint.costUsd != null ? `$${sprint.costUsd.toFixed(3)}` : '—', sub: 'USD Total', color: 'text-text-secondary' },
                    { icon: TrendingUp, label: 'Velocity', value: throughput ? `${throughput}/m` : '—', sub: 'tasks / min', color: 'text-text-secondary' },
                ].map(({ icon: Icon, label, value, sub, color }) => (
                    <div key={label} className="rounded-xl border border-border bg-surface-1/40 p-4 flex flex-col gap-1 shadow-sm">
                        <div className="flex items-center gap-1.5 text-text-muted">
                            <Icon className="h-3 w-3" />
                            <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
                        </div>
                        <div className={cn("text-xl font-bold tracking-tight", color)}>{value}</div>
                        <div className="text-[10px] text-zinc-600 font-mono mt-1">{sub}</div>
                    </div>
                ))}
            </div>

            {/* Progress Visualization */}
            <div className="rounded-xl border border-border bg-surface-1/50 p-5 shadow-inner">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-text-secondary uppercase tracking-widest text-shadow-glow">Performance Engine</span>
                        <div className="flex gap-1">
                            {Array.from({ length: 3 }).map((_, i) => (
                                <span key={i} className={cn("h-1 w-3 rounded-full", i < (progressPct / 33) ? "bg-azure shadow-[0_0_8px_var(--color-azure)]" : "bg-zinc-800")} />
                            ))}
                        </div>
                    </div>
                    <span className="text-xs font-mono text-text-muted bg-surface-2 px-2 py-0.5 rounded-md border border-border">
                        {progressPct}% Completion · {sprint.completedTasks}/{sprint.totalTasks} Done
                    </span>
                </div>
                <div className="space-y-1.5">
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-1000 ease-in-out bg-gradient-to-r from-azure/60 to-azure shadow-[0_0_15px_var(--color-azure-dim)]"
                            style={{ width: `${progressPct}%` }}
                        />
                    </div>
                    {sprint.failedTasks > 0 && (
                        <div
                            className="h-1 rounded-full bg-red/30 transition-all duration-1000"
                            style={{ width: `${Math.round((sprint.failedTasks / sprint.totalTasks) * 100)}%` }}
                        />
                    )}
                </div>
            </div>

            {/* Main Content Area (Tabs) */}
            <div className="flex flex-col gap-6">
                <div className="flex items-center gap-1 border-b border-border/50 scrollbar-hide overflow-x-auto whitespace-nowrap">
                    {([
                        { id: 'workers' as const, label: `${def.unitPlural} (${tasks.length})`, badge: false },
                        { id: 'tasks' as const, label: `Status Matrix`, badge: false },
                        { id: 'features' as const, label: `Features (${sprint.featuresCompleted.length})`, badge: false },
                        { id: 'deliverables' as const, label: 'Deliverables', badge: delivLoading },
                        { id: 'log' as const, label: 'DevTrace', badge: isActive },
                    ]).map(({ id, label, badge }) => (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            className={cn(
                                "px-5 py-3 text-xs font-bold uppercase tracking-widest transition-all border-b-2 -mb-px flex items-center gap-2",
                                tab === id
                                    ? "border-azure text-zinc-50 bg-azure/5"
                                    : "border-transparent text-text-muted hover:text-text-secondary hover:bg-surface-1/50"
                            )}
                        >
                            {id === 'log' && <Terminal className="h-3.5 w-3.5" />}
                            {label}
                            {badge && (
                                <span className="h-1.5 w-1.5 rounded-full bg-azure animate-pulse" />
                            )}
                        </button>
                    ))}
                </div>

                <div className="min-h-[400px]">
                    {tab === 'workers' && (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 animate-in slide-in-from-bottom-2 duration-300">
                            {tasks.length === 0 ? (
                                <div className="col-span-full flex flex-col items-center justify-center py-20 text-text-muted gap-3 border border-dashed border-border rounded-xl">
                                    <Cpu className="h-8 w-8 opacity-20" />
                                    <p className="text-sm">Initializing {def.unitPlural.toLowerCase()} team...</p>
                                </div>
                            ) : (
                                tasks.map((t) => <WorkerCard key={t.id} task={t} />)
                            )}
                        </div>
                    )}

                    {tab === 'tasks' && (
                        <div className="rounded-xl border border-border bg-surface-1/20 overflow-hidden shadow-xl animate-in fade-in duration-300">
                             {tasks.length === 0 ? (
                                <p className="py-20 text-center text-sm text-text-muted">Operation pending...</p>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left">
                                        <thead>
                                            <tr className="border-b border-border/50 bg-surface-1/40">
                                                <th className="px-5 py-3 text-[10px] font-bold text-text-muted uppercase tracking-widest w-16">Rank</th>
                                                <th className="px-5 py-3 text-[10px] font-bold text-text-muted uppercase tracking-widest">Objective</th>
                                                {isCode && <th className="px-5 py-3 text-[10px] font-bold text-text-muted uppercase tracking-widest">Environment</th>}
                                                <th className="px-5 py-3 text-[10px] font-bold text-text-muted uppercase tracking-widest w-32 text-center">Efficiency</th>
                                                {isCode && <th className="px-5 py-3 text-[10px] font-bold text-text-muted uppercase tracking-widest w-24 text-right">Artifact</th>}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border/30">
                                            {tasks.map((t) => (
                                                <tr key={t.id} className="hover:bg-azure/5 transition-colors group/row">
                                                    <td className="px-5 py-4 text-[10px] font-mono text-zinc-600">{t.priority}</td>
                                                    <td className="px-5 py-4">
                                                        <Link href={`/tasks/${t.id}`} className="block group">
                                                            <p className="text-sm font-medium text-text-primary group-hover:text-azure transition-colors leading-snug">{t.description}</p>
                                                            <div className="flex flex-wrap gap-1.5 mt-2">
                                                                {t.scope.slice(0, 4).map((s) => (
                                                                    <span key={s} className="rounded-md bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[9px] font-mono text-zinc-500 uppercase">{s}</span>
                                                                ))}
                                                            </div>
                                                        </Link>
                                                    </td>
                                                    {isCode && (
                                                       <td className="px-5 py-4">
                                                            <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted bg-surface-2 px-2 py-1 rounded-lg border border-border/40 w-fit">
                                                                <GitBranch className="h-3 w-3" />
                                                                <span className="truncate max-w-[120px]">{t.branch}</span>
                                                            </div>
                                                       </td>
                                                    )}
                                                    <td className="px-5 py-4 text-center">
                                                        <StatusBadge status={t.status} showIcon={false} size="sm" className="mx-auto" />
                                                    </td>
                                                    {isCode && (
                                                        <td className="px-5 py-4 text-right">
                                                            {t.handoff?.prUrl ? (
                                                                <a
                                                                    href={t.handoff.prUrl}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="inline-flex items-center gap-1.5 text-[10px] font-bold text-azure hover:text-white transition-colors"
                                                                >
                                                                    PR #{t.handoff.prNumber} 
                                                                    <ExternalLink className="h-3 w-3" />
                                                                </a>
                                                            ) : <span className="text-zinc-800 font-mono text-xs">—</span>}
                                                        </td>
                                                    )}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'features' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 animate-in fade-in duration-300">
                            {sprint.featuresCompleted.length === 0 ? (
                                <div className="col-span-full py-20 text-center text-sm text-text-muted border border-dashed border-border rounded-xl">
                                    No features delivered yet.
                                </div>
                            ) : (
                                sprint.featuresCompleted.map((f, i) => (
                                    <div key={i} className="flex items-start gap-4 rounded-xl border border-border bg-surface-1/40 px-5 py-4 hover:border-azure/20 transition-all group">
                                        <div className="mt-1 rounded-full p-1.5 bg-azure/10 text-azure group-hover:scale-110 transition-transform">
                                            <Zap className="h-4 w-4 fill-current" />
                                        </div>
                                        <p className="text-sm text-text-secondary leading-relaxed pt-1">{f}</p>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                    {tab === 'deliverables' && (
                        <div className="flex flex-col gap-3 animate-in slide-in-from-bottom-2 duration-300">
                            {delivLoading ? (
                                <div className="flex flex-col items-center gap-4 py-20 text-center">
                                    <div className="relative">
                                        <div className="h-10 w-10 rounded-full border-2 border-azure/20" />
                                        <div className="absolute inset-0 h-10 w-10 rounded-full border-2 border-azure border-t-transparent animate-spin" />
                                    </div>
                                    <span className="text-sm font-bold text-text-muted uppercase tracking-widest">Compiling Deliverables</span>
                                </div>
                            ) : deliverables.length === 0 ? (
                                <div className="flex flex-col items-center gap-4 py-20 text-center border border-dashed border-border rounded-2xl bg-surface-1/10">
                                    <div className="rounded-full bg-surface-2 p-5 text-zinc-700">
                                        <FileText className="h-10 w-10" />
                                    </div>
                                    <div className="max-w-xs space-y-2">
                                        <p className="text-sm font-bold text-text-primary uppercase tracking-wider">No artifacts detected</p>
                                        <p className="text-xs text-text-muted leading-relaxed">Agent-produced documents, reports, or research summaries will propagate here as work cycles complete.</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 gap-4">
                                    {deliverables.map((d, i) => {
                                        const key = `${d.taskId}-${d.filename}`
                                        const isOpen = openDeliv === key
                                        return (
                                            <div key={i} className={cn(
                                                "rounded-2xl border transition-all duration-300 overflow-hidden shadow-lg",
                                                isOpen ? "border-azure/40 bg-zinc-950 ring-1 ring-azure/10" : "border-border bg-surface-1/40 hover:border-azure/20"
                                            )}>
                                                <button
                                                    onClick={() => setOpenDeliv(isOpen ? null : key)}
                                                    className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-2/30 transition-colors"
                                                >
                                                    <div className="flex items-center gap-4">
                                                        <div className={cn(
                                                            "p-2.5 rounded-xl transition-all",
                                                            isOpen ? "bg-azure text-white" : "bg-surface-2 text-text-muted"
                                                        )}>
                                                            <FileText className="h-5 w-5" />
                                                        </div>
                                                        <div>
                                                            <p className="text-sm font-bold text-text-primary tracking-tight">{d.filename}</p>
                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                <span className="text-[10px] font-mono text-zinc-500 uppercase">{(d.bytes / 1024).toFixed(1)} KB</span>
                                                                <span className="text-zinc-800">·</span>
                                                                <span className="text-[10px] font-mono text-text-muted">Task ID: {d.taskId.slice(0, 8)}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className={cn(
                                                        "p-1.5 rounded-lg border border-border text-text-muted transition-all",
                                                        isOpen && "border-azure/30 text-azure"
                                                    )}>
                                                        <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
                                                    </div>
                                                </button>
                                                {isOpen && d.content && (
                                                    <div className="border-t border-border/50 bg-black/40">
                                                        <div className="flex items-center justify-between px-5 py-2 bg-surface-1/60 border-b border-border/30">
                                                             <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Raw Manifest Source</span>
                                                             <button 
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    void navigator.clipboard.writeText(d.content!);
                                                                }}
                                                                className="text-[9px] font-bold text-azure hover:text-white transition-colors uppercase tracking-widest"
                                                             >
                                                                Copy Content
                                                             </button>
                                                        </div>
                                                        <div className="p-5 overflow-hidden">
                                                            <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto max-h-[60vh] leading-loose custom-scrollbar">{d.content}</pre>
                                                        </div>
                                                    </div>
                                                )}
                                                {isOpen && !d.content && (
                                                    <div className="border-t border-border p-8 text-center bg-black/40">
                                                        <p className="text-xs text-text-muted font-medium italic">Binary stream detected. External software required for visual projection.</p>
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'log' && (
                        <div className="rounded-2xl border border-border bg-black/40 p-4 shadow-2xl animate-in zoom-in-95 duration-300 ring-1 ring-zinc-800/50">
                            <ActivityLog sprintId={sprintId} isActive={isActive} />
                        </div>
                    )}
                </div>
            </div>

            {/* Terminal Metadata Footer */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[10px] text-zinc-600 font-mono pt-6 border-t border-border/30 mt-4 opacity-60">
                <div className="flex items-center gap-1.5">
                    <span className="text-zinc-800">UUID.</span>
                    <code className="text-zinc-500">{sprint.id}</code>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="text-zinc-800">EPOCH.</span>
                    <span>{new Date(sprint.createdAt).getTime()}</span>
                </div>
                {sprint.plannerIterations > 0 && (
                     <div className="flex items-center gap-1.5">
                        <span className="text-zinc-800">PLAN.ITERATIONS.</span>
                        <span className="text-azure-dim">{sprint.plannerIterations}</span>
                    </div>
                )}
                {sprint.qualityScore != null && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-zinc-800">QUAL.INDEX.</span>
                        <span className={cn(sprint.qualityScore >= 0.8 ? "text-azure" : "text-amber")}>{(sprint.qualityScore * 100).toFixed(1)}%</span>
                    </div>
                )}
                {sprint.totalTokens != null && (
                    <div className="flex items-center gap-1.5 ml-auto">
                        <span className="text-zinc-800">IO.TOKENS.</span>
                        <span>{(sprint.totalTokens / 1000).toFixed(1)}k</span>
                    </div>
                )}
            </div>
        </div>
    )
}
