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
    Code2,
    Search,
    PenLine,
    Server,
    BarChart2,
    Megaphone,
    Sparkles,
    Terminal,
    ChevronDown,
    GitPullRequest,
    Cpu,
    AlertCircle,
    CheckCheck,
    Play,
    Layers,
    BadgeDollarSign,
    Wifi,
} from 'lucide-react'
import Link from 'next/link'
import { getCategoryDef } from '@web/lib/project-categories'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SprintTaskItem {
    id: string
    description: string
    scope: string[]
    acceptance: string
    branch: string
    priority: number
    status: 'queued' | 'running' | 'complete' | 'blocked' | 'failed'
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
    | 'pr_created' | 'pr_failed'
    | 'conflict_detected' | 'budget_check' | 'budget_ceiling_hit'
    | 'sprint_complete' | 'sprint_failed'
    | 'branch_created' | 'branch_failed'

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

const STATUS_CONFIG: Record<string, { bg: string; text: string; dot: string; label: string }> = {
    queued: { bg: 'bg-zinc-700/50', text: 'text-zinc-300', dot: 'bg-zinc-500', label: 'Queued' },
    running: { bg: 'bg-blue-500/15', text: 'text-blue-400', dot: 'bg-blue-400 animate-pulse', label: 'Running' },
    complete: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400', label: 'Complete' },
    blocked: { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400', label: 'Blocked' },
    failed: { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-400', label: 'Failed' },
    planning: { bg: 'bg-purple-500/15', text: 'text-purple-400', dot: 'bg-purple-400 animate-pulse', label: 'Planning' },
    finalizing: { bg: 'bg-cyan-500/15', text: 'text-cyan-400', dot: 'bg-cyan-400 animate-pulse', label: 'Finalizing' },
    cancelled: { bg: 'bg-zinc-700/30', text: 'text-zinc-500', dot: 'bg-zinc-600', label: 'Cancelled' },
}

// ── Log event config ──────────────────────────────────────────────────────────

const LOG_EVENT_CONFIG: Record<SprintLogEvent, {
    icon: React.ElementType
    color: string
    bgColor: string
    label: string
}> = {
    planning_start: { icon: Sparkles, color: 'text-violet-400', bgColor: 'bg-violet-500/10 border-violet-500/20', label: 'Planning' },
    planning_complete: { icon: CheckCheck, color: 'text-violet-400', bgColor: 'bg-violet-500/10 border-violet-500/20', label: 'Plan Ready' },
    wave_start: { icon: Layers, color: 'text-blue-400', bgColor: 'bg-blue-500/10 border-blue-500/20', label: 'Wave' },
    wave_complete: { icon: CheckCheck, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10 border-emerald-500/20', label: 'Wave Done' },
    task_queued: { icon: Play, color: 'text-sky-400', bgColor: 'bg-sky-500/10 border-sky-500/20', label: 'Queued' },
    task_running: { icon: Cpu, color: 'text-blue-400', bgColor: 'bg-blue-500/10 border-blue-500/20', label: 'Running' },
    task_complete: { icon: CheckCircle2, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10 border-emerald-500/20', label: 'Done' },
    task_failed: { icon: XCircle, color: 'text-red-400', bgColor: 'bg-red-500/10 border-red-500/20', label: 'Failed' },
    task_timeout: { icon: Clock, color: 'text-amber-400', bgColor: 'bg-amber-500/10 border-amber-500/20', label: 'Timeout' },
    pr_created: { icon: GitPullRequest, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10 border-emerald-500/20', label: 'PR' },
    pr_failed: { icon: AlertCircle, color: 'text-red-400', bgColor: 'bg-red-500/10 border-red-500/20', label: 'PR Failed' },
    conflict_detected: { icon: AlertTriangle, color: 'text-amber-400', bgColor: 'bg-amber-500/10 border-amber-500/20', label: 'Conflict' },
    budget_check: { icon: BadgeDollarSign, color: 'text-zinc-400', bgColor: 'bg-zinc-800/60 border-zinc-700/30', label: 'Budget' },
    budget_ceiling_hit: { icon: AlertTriangle, color: 'text-amber-400', bgColor: 'bg-amber-500/10 border-amber-500/20', label: 'Budget Limit' },
    sprint_complete: { icon: CheckCheck, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10 border-emerald-500/20', label: 'Complete' },
    sprint_failed: { icon: XCircle, color: 'text-red-400', bgColor: 'bg-red-500/10 border-red-500/20', label: 'Failed' },
    branch_created: { icon: GitBranch, color: 'text-sky-400', bgColor: 'bg-sky-500/10 border-sky-500/20', label: 'Branch' },
    branch_failed: { icon: AlertCircle, color: 'text-amber-400', bgColor: 'bg-amber-500/10 border-amber-500/20', label: 'Branch Err' },
}

const LEVEL_COLORS: Record<SprintLogLevel, string> = {
    info: 'text-zinc-500',
    warn: 'text-amber-500',
    error: 'text-red-500',
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
    const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.queued!
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label}
        </span>
    )
}

function formatMs(ms: number | null | undefined): string {
    if (!ms) return '—'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Worker Grid item ──────────────────────────────────────────────────────────

function WorkerCard({ task }: { task: SprintTaskItem }) {
    const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.queued!
    void cfg
    return (
        <div className={`rounded-lg border ${task.status === 'running' ? 'border-blue-700/50' : 'border-zinc-800'} bg-zinc-900/60 p-3 flex flex-col gap-2 transition-all`}>
            <div className="flex items-center justify-between gap-2">
                <StatusBadge status={task.status} />
                <span className="text-[10px] font-mono text-zinc-600">#{task.priority}</span>
            </div>
            <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{task.description}</p>
            <div className="flex items-center gap-1 text-[10px] font-mono text-zinc-600">
                <GitBranch className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{task.branch}</span>
            </div>
            {task.handoff?.prUrl && (
                <a
                    href={task.handoff.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                >
                    <ExternalLink className="h-2.5 w-2.5" />
                    PR #{task.handoff.prNumber}
                </a>
            )}
            {task.completedAt && (
                <span className="text-[10px] text-zinc-600">{timeAgo(task.completedAt)}</span>
            )}
        </div>
    )
}

const CATEGORY_ICONS: Record<string, React.ElementType> = {
    Code2, Search, PenLine, Server, BarChart2, Megaphone, Sparkles,
}

function CategoryBadge({ category }: { category: string }) {
    const def = getCategoryDef(category)
    const Icon = CATEGORY_ICONS[def.icon] ?? Sparkles
    return (
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-zinc-700/60 bg-zinc-800/60 text-zinc-400">
            <Icon className="h-2.5 w-2.5" />
            {def.label}
        </span>
    )
}

// ── Activity Log entry ────────────────────────────────────────────────────────

function LogEntry({ entry, isNew }: { entry: SprintLogEntry; isNew?: boolean }) {
    const cfg = LOG_EVENT_CONFIG[entry.event] ?? LOG_EVENT_CONFIG.task_running
    const Icon = cfg.icon
    const [expanded, setExpanded] = useState(false)
    const hasMetadata = Object.keys(entry.metadata ?? {}).length > 0 &&
        !(['budget_check'].includes(entry.event) && Object.keys(entry.metadata).length <= 2)

    return (
        <div
            className={`
                group flex gap-3 px-3 py-2.5 rounded-lg border transition-all duration-300
                ${cfg.bgColor}
                ${isNew ? 'animate-[fadeSlideIn_0.3s_ease-out]' : ''}
            `}
        >
            {/* Icon */}
            <div className={`shrink-0 mt-0.5 ${cfg.color}`}>
                <Icon className="h-3.5 w-3.5" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.color} opacity-70`}>
                            {cfg.label}
                        </span>
                        <p className="text-xs text-zinc-300 leading-relaxed">{entry.message}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-mono ${LEVEL_COLORS[entry.level]}`}>
                            {entry.level !== 'info' ? entry.level.toUpperCase() : ''}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-600 tabular-nums">
                            {formatTime(entry.createdAt)}
                        </span>
                        {hasMetadata && (
                            <button
                                onClick={() => setExpanded(!expanded)}
                                className="text-zinc-600 hover:text-zinc-400 transition-colors"
                            >
                                <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Expandable metadata */}
                {expanded && hasMetadata && (
                    <div className="mt-2 rounded bg-black/30 border border-zinc-800/50 p-2">
                        <pre className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap overflow-x-auto max-h-40">
                            {JSON.stringify(entry.metadata, null, 2)}
                        </pre>
                    </div>
                )}

                {/* Branch inline display */}
                {(entry.metadata?.branch as string) && !expanded && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-zinc-600">
                        <GitBranch className="h-2.5 w-2.5" />
                        {entry.metadata.branch as string}
                    </div>
                )}

                {/* PR link inline */}
                {(entry.metadata?.prUrl as string) && (
                    <a
                        href={entry.metadata.prUrl as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`mt-1 inline-flex items-center gap-1 text-[10px] ${cfg.color} hover:opacity-80 transition-opacity`}
                    >
                        <ExternalLink className="h-2.5 w-2.5" />
                        View PR #{entry.metadata.prNumber as number}
                    </a>
                )}
            </div>
        </div>
    )
}

// ── Activity Log panel ────────────────────────────────────────────────────────

function ActivityLog({ sprintId, isActive }: { sprintId: string; isActive: boolean }) {
    const [logs, setLogs] = useState<SprintLogEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [newIds, setNewIds] = useState<Set<string>>(new Set())
    const [autoScroll, setAutoScroll] = useState(true)
    const [liveConnected, setLiveConnected] = useState(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const seenIds = useRef<Set<string>>(new Set())

    const fetchLogs = useCallback(async (silent = false) => {
        try {
            if (!silent) setLoading(true)
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/logs`)
            if (!res.ok) return
            const data = await res.json() as { logs: SprintLogEntry[] }
            const incoming = data.logs ?? []

            // Mark new entries for animation
            const freshIds = new Set<string>()
            for (const e of incoming) {
                if (!seenIds.current.has(e.id)) {
                    freshIds.add(e.id)
                    seenIds.current.add(e.id)
                }
            }
            if (freshIds.size > 0) setNewIds(freshIds)
            setLogs(incoming)
        } catch { /* silent */ } finally {
            setLoading(false)
        }
    }, [sprintId])

    // Initial load
    useEffect(() => { void fetchLogs() }, [fetchLogs])

    // SSE live updates
    useEffect(() => {
        const es = new EventSource(`${API}/api/v1/sse?workspaceId=sprint-${sprintId}`)
        es.onopen = () => setLiveConnected(true)
        es.onmessage = (e) => {
            try {
                const ev = JSON.parse(e.data as string) as { type: string; event?: string }
                if (ev.type === 'sprint_log') {
                    // Append live log entry directly
                    const entry = ev as unknown as SprintLogEntry & { type: string }
                    setLogs((prev) => {
                        if (prev.some((p) => p.id === entry.id)) return prev
                        seenIds.current.add(entry.id)
                        setNewIds((n) => new Set([...n, entry.id]))
                        return [...prev, entry]
                    })
                }
            } catch { /* ignore */ }
        }
        es.onerror = () => {
            setLiveConnected(false)
            es.close()
        }
        return () => { es.close(); setLiveConnected(false) }
    }, [sprintId])

    // Polling fallback for active sprints
    useEffect(() => {
        if (!isActive) return
        const t = setInterval(() => void fetchLogs(true), 8_000)
        return () => clearInterval(t)
    }, [isActive, fetchLogs])

    // Auto-scroll to bottom
    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [logs, autoScroll])

    // Clear new animation flags after delay
    useEffect(() => {
        if (newIds.size === 0) return
        const t = setTimeout(() => setNewIds(new Set()), 800)
        return () => clearTimeout(t)
    }, [newIds])

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget
        const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40
        setAutoScroll(isAtBottom)
    }

    if (loading && logs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-600">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <p className="text-sm">Loading activity log…</p>
            </div>
        )
    }

    if (logs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-600">
                <Terminal className="h-8 w-8 opacity-30" />
                <p className="text-sm">No activity yet — logs will appear as agents work</p>
                {isActive && (
                    <div className="flex items-center gap-1.5 text-xs text-violet-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
                        Agents are planning…
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Log toolbar */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{logs.length} events</span>
                    {isActive && (
                        <div className={`flex items-center gap-1.5 text-[10px] font-medium ${liveConnected ? 'text-emerald-400' : 'text-zinc-600'}`}>
                            <Wifi className="h-2.5 w-2.5" />
                            {liveConnected ? 'Live' : 'Polling'}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchLogs(true)}
                        className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
                    >
                        <RefreshCw className="h-2.5 w-2.5" />
                        Refresh
                    </button>
                    <button
                        onClick={() => {
                            setAutoScroll(true)
                            if (scrollRef.current) {
                                scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                            }
                        }}
                        className={`text-[11px] transition-colors flex items-center gap-1 ${autoScroll ? 'text-indigo-400' : 'text-zinc-600 hover:text-zinc-400'}`}
                    >
                        <ChevronDown className="h-2.5 w-2.5" />
                        {autoScroll ? 'Auto-scroll on' : 'Scroll to bottom'}
                    </button>
                </div>
            </div>

            {/* Log feed */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex flex-col gap-1.5 max-h-[640px] overflow-y-auto pr-1 scroll-smooth"
                style={{ scrollbarWidth: 'thin', scrollbarColor: '#3f3f46 transparent' }}
            >
                {logs.map((entry) => (
                    <LogEntry
                        key={entry.id}
                        entry={entry}
                        isNew={newIds.has(entry.id)}
                    />
                ))}

                {/* Blinking cursor when active */}
                {isActive && (
                    <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-zinc-600">
                        <span className="text-violet-400 animate-pulse">▊</span>
                        agents working…
                    </div>
                )}
            </div>
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectControlRoom() {
    const params = useParams<{ id: string }>()
    const router = useRouter()
    const sprintId = params.id
    const [data, setData] = useState<SprintDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)
    const [elapsedMs, setElapsedMs] = useState(0)
    const [tab, setTab] = useState<'workers' | 'tasks' | 'features' | 'log'>('workers')
    const esRef = useRef<EventSource | null>(null)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(`${API}/api/v1/sprints/${sprintId}/tasks`, { cache: 'no-store' })
            if (res.status === 404) { setNotFound(true); return }
            if (!res.ok) return
            const d = await res.json() as SprintDetail
            setData(d)
        } catch { /* silent */ } finally {
            setLoading(false)
        }
    }, [sprintId])

    useEffect(() => { void fetchData() }, [fetchData])

    useEffect(() => {
        if (!data) return
        const isActive = ['planning', 'running', 'finalizing'].includes(data.sprint.status)
        if (!isActive) return
        const t = setInterval(() => void fetchData(), 5_000)
        return () => clearInterval(t)
    }, [data?.sprint.status, fetchData])

    useEffect(() => {
        if (!data?.sprint.createdAt) return
        const isActive = ['planning', 'running', 'finalizing'].includes(data.sprint.status)
        if (isActive) {
            const tick = () => setElapsedMs(Date.now() - new Date(data.sprint.createdAt).getTime())
            tick()
            timerRef.current = setInterval(tick, 1000)
            return () => { if (timerRef.current) clearInterval(timerRef.current) }
        } else {
            setElapsedMs(data.sprint.wallClockMs ?? (Date.now() - new Date(data.sprint.createdAt).getTime()))
        }
    }, [data?.sprint.status, data?.sprint.createdAt, data?.sprint.wallClockMs])

    useEffect(() => {
        const es = new EventSource(`${API}/api/v1/sse?workspaceId=sprint-${sprintId}`)
        esRef.current = es
        es.onmessage = (e) => {
            try {
                const ev = JSON.parse(e.data as string) as { type: string }
                if (ev.type.startsWith('sprint_') || ev.type.startsWith('task_')) void fetchData()
            } catch { /* ignore */ }
        }
        es.onerror = () => { es.close(); esRef.current = null }
        return () => { es.close(); esRef.current = null }
    }, [sprintId, fetchData])

    if (loading) return (
        <div className="flex items-center gap-2 py-16 justify-center text-sm text-zinc-600">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading project…
        </div>
    )

    if (notFound) return (
        <div className="flex flex-col items-center gap-4 py-16">
            <p className="text-zinc-400">Project not found</p>
            <Link href="/projects" className="text-sm text-indigo-400 hover:text-indigo-300">← Back to Projects</Link>
        </div>
    )

    if (!data) return null

    const { sprint, tasks } = data
    const def = getCategoryDef(sprint.category ?? 'code')
    const isCode = sprint.category === 'code' || !sprint.category
    const progressPct = sprint.totalTasks > 0
        ? Math.round((sprint.completedTasks / sprint.totalTasks) * 100)
        : 0
    const isActive = ['planning', 'running', 'finalizing'].includes(sprint.status)
    const runningTasks = tasks.filter((t) => t.status === 'running')
    const throughput = sprint.wallClockMs && sprint.completedTasks
        ? (sprint.completedTasks / (sprint.wallClockMs / 60_000)).toFixed(1)
        : null

    const workersByStatus = {
        running: tasks.filter((t) => t.status === 'running'),
        queued: tasks.filter((t) => t.status === 'queued'),
        complete: tasks.filter((t) => t.status === 'complete'),
        failed: tasks.filter((t) => t.status === 'failed'),
        blocked: tasks.filter((t) => t.status === 'blocked'),
    }
    void workersByStatus

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => router.push('/projects')}
                            className="text-zinc-500 hover:text-zinc-300 transition-colors"
                            aria-label="Back"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                        <h1 className="text-xl font-bold text-zinc-50">
                            {def.runLabel} Control Room
                        </h1>
                        <StatusBadge status={sprint.status} />
                        <CategoryBadge category={sprint.category ?? 'code'} />
                    </div>
                    {isCode && sprint.repo && (
                        <p className="pl-6 text-sm font-mono text-zinc-500">{sprint.repo}</p>
                    )}
                </div>
                <button
                    onClick={() => void fetchData()}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    aria-label="Refresh"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isActive ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Request card */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                <p className="text-sm text-zinc-300 leading-relaxed">{sprint.request}</p>
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                {[
                    { icon: CheckCircle2, label: 'Complete', value: String(sprint.completedTasks), sub: `of ${sprint.totalTasks}`, color: 'text-emerald-400' },
                    { icon: XCircle, label: 'Failed', value: String(sprint.failedTasks), sub: 'tasks', color: sprint.failedTasks > 0 ? 'text-red-400' : 'text-zinc-600' },
                    { icon: AlertTriangle, label: 'Conflicts', value: String(sprint.conflictCount), sub: 'merges', color: sprint.conflictCount > 0 ? 'text-amber-400' : 'text-zinc-600' },
                    { icon: Clock, label: 'Elapsed', value: formatMs(isActive ? elapsedMs : sprint.wallClockMs), sub: '', color: 'text-zinc-300' },
                    { icon: DollarSign, label: 'Cost', value: sprint.costUsd != null ? `$${sprint.costUsd.toFixed(3)}` : '—', sub: 'USD', color: 'text-zinc-300' },
                    { icon: TrendingUp, label: 'Velocity', value: throughput ? `${throughput}/m` : '—', sub: 'tasks/min', color: 'text-zinc-300' },
                ].map(({ icon: Icon, label, value, sub, color }) => (
                    <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                            <Icon className="h-3.5 w-3.5" />
                            <span className="text-[11px]">{label}</span>
                        </div>
                        <div className={`text-xl font-bold ${color}`}>{value}</div>
                        {sub && <div className="text-[10px] text-zinc-600">{sub}</div>}
                    </div>
                ))}
            </div>

            {/* Progress bar */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Progress</span>
                    <span className="text-xs font-mono text-zinc-500">{progressPct}% · {sprint.completedTasks}/{sprint.totalTasks}</span>
                </div>
                <div className="h-2 rounded-full bg-zinc-800">
                    <div
                        className={`h-2 rounded-full transition-all duration-700 ${sprint.failedTasks > 0 ? 'bg-gradient-to-r from-emerald-500 to-emerald-600' : 'bg-emerald-500'}`}
                        style={{ width: `${progressPct}%` }}
                    />
                </div>
                {sprint.failedTasks > 0 && (
                    <div
                        className="h-1 rounded-full mt-1 bg-red-500/40 transition-all duration-700"
                        style={{ width: `${Math.round((sprint.failedTasks / sprint.totalTasks) * 100)}%` }}
                    />
                )}
            </div>

            {/* Live worker status */}
            {isActive && runningTasks.length > 0 && (
                <div className="rounded-xl border border-blue-800/40 bg-blue-950/10 p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                        <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">{runningTasks.length} Workers Active</span>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {runningTasks.map((t) => (
                            <div key={t.id} className="rounded-lg bg-blue-950/20 border border-blue-800/30 px-3 py-2 text-xs">
                                <p className="text-blue-200 line-clamp-1">{t.description}</p>
                                <code className="text-blue-500/70 font-mono text-[10px]">{t.branch}</code>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Tabs */}
            <div className="flex flex-col gap-4">
                <div className="flex gap-1 border-b border-zinc-800">
                    {([
                        { id: 'workers' as const, label: `${def.unitPlural} (${tasks.length})`, badge: false },
                        { id: 'tasks' as const, label: `All ${def.unitPlural.toLowerCase()}`, badge: false },
                        { id: 'features' as const, label: `Delivered (${sprint.featuresCompleted.length})`, badge: false },
                        { id: 'log' as const, label: 'Activity Log', badge: isActive },
                    ]).map(({ id, label, badge }) => (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 ${tab === id
                                ? 'border-indigo-500 text-zinc-100'
                                : 'border-transparent text-zinc-500 hover:text-zinc-300'
                                }`}
                        >
                            {id === 'log' && <Terminal className="h-3 w-3" />}
                            {label}
                            {badge && (
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            )}
                        </button>
                    ))}
                </div>

                {tab === 'workers' && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {tasks.length === 0 ? (
                            <p className="col-span-full text-center py-8 text-sm text-zinc-600">No {def.unitPlural.toLowerCase()} yet — project is planning.</p>
                        ) : (
                            tasks.map((t) => <WorkerCard key={t.id} task={t} />)
                        )}
                    </div>
                )}

                {tab === 'tasks' && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                        {tasks.length === 0 ? (
                            <p className="py-8 text-center text-sm text-zinc-600">No tasks yet.</p>
                        ) : (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-zinc-800 text-left">
                                        <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase">#</th>
                                        <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase">{def.unitSingular}</th>
                                        {isCode && <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase">Branch</th>}
                                        <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase">Status</th>
                                        {isCode && <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase">PR</th>}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-800/50">
                                    {tasks.map((t) => (
                                        <tr key={t.id} className="hover:bg-zinc-800/20 transition-colors">
                                            <td className="px-4 py-2.5 text-xs font-mono text-zinc-600">{t.priority}</td>
                                            <td className="px-4 py-2.5 text-zinc-300 max-w-xs">
                                                <p className="truncate">{t.description}</p>
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {(t.scope as string[]).slice(0, 3).map((s) => (
                                                        <span key={s} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">{s}</span>
                                                    ))}
                                                </div>
                                            </td>
                                            {isCode && (
                                                <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-500 max-w-[140px]">
                                                    <span className="truncate block">{t.branch}</span>
                                                </td>
                                            )}
                                            <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                                            {isCode && (
                                                <td className="px-4 py-2.5">
                                                    {t.handoff?.prUrl ? (
                                                        <a
                                                            href={t.handoff.prUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                                                        >
                                                            #{t.handoff.prNumber} <ExternalLink className="h-3 w-3" />
                                                        </a>
                                                    ) : <span className="text-zinc-700">—</span>}
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}

                {tab === 'features' && (
                    <div className="flex flex-col gap-2">
                        {sprint.featuresCompleted.length === 0 ? (
                            <p className="py-8 text-center text-sm text-zinc-600">No features delivered yet.</p>
                        ) : (
                            sprint.featuresCompleted.map((f, i) => (
                                <div key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                                    <Zap className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                                    <p className="text-sm text-zinc-300">{f}</p>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {tab === 'log' && (
                    <ActivityLog sprintId={sprintId} isActive={isActive} />
                )}
            </div>

            {/* Metadata footer */}
            <div className="flex items-center gap-4 text-xs text-zinc-600 pt-2">
                <span>ID: <code className="font-mono">{sprint.id}</code></span>
                <span>Started {timeAgo(sprint.createdAt)}</span>
                {sprint.plannerIterations > 0 && <span>{sprint.plannerIterations} planner iterations</span>}
                {sprint.qualityScore != null && <span>Quality: {Math.round(sprint.qualityScore * 100)}%</span>}
                {sprint.totalTokens != null && <span>{(sprint.totalTokens / 1000).toFixed(1)}k tokens</span>}
            </div>
        </div>
    )
}
