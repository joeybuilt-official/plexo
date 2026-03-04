'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
    Activity,
    Zap,
    MessageSquare,
    DollarSign,
    Clock,
    GitBranch,
    RefreshCw,
    ArrowRight,
} from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'

// ── Types ────────────────────────────────────────────────────────────────────

interface DashboardSummary {
    agent: {
        status: 'idle' | 'running'
        activeTasks: number
        queuedTasks: number
        connectedClients: number
    }
    tasks: {
        byStatus: Record<string, number>
        total: number
        recentActivity: Array<{
            id: string
            type: string
            status: string
            outcomeSummary: string | null
            qualityScore: number | null
            completedAt: string | null
        }>
    }
    cost: {
        total: number
        thisWeek: number
        ceiling: number
        percentUsed: number
    }
    steps: {
        thisWeek: number
        tokensThisWeek: number
    }
}

interface ChannelHealth {
    id: string
    name: string
    type: string
    status: string
    lastActivityAt: string | null
}

interface Task {
    id: string
    type: string
    status: string
    outcomeSummary: string | null
    source: string
    createdAt: string
    completedAt: string | null
    qualityScore: number | null
    costUsd: number | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const POLL_MS = 15_000
const ACTIVITY_POLL_MS = 10_000
const CHANNEL_POLL_MS = 30_000

const STATUS_COLORS: Record<string, string> = {
    complete: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    running: 'bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse',
    queued: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    blocked: 'bg-red-500/20 text-red-400 border-red-500/30',
    cancelled: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
    claimed: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
}

function timeAgo(iso: string): string {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
}

// ── Main component ────────────────────────────────────────────────────────────

export function LiveDashboard() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [summary, setSummary] = useState<DashboardSummary | null>(null)
    const [tasks, setTasks] = useState<Task[]>([])
    const [channels, setChannels] = useState<ChannelHealth[]>([])
    const [refreshing, setRefreshing] = useState(false)
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
    const esRef = useRef<EventSource | null>(null)

    const fetchSummary = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/summary?workspaceId=${WS_ID}`)
            if (res.ok) {
                setSummary(await res.json() as DashboardSummary)
                setLastUpdated(new Date())
            }
        } catch { /* silent — keep stale data */ }
    }, [])

    const fetchActivity = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/activity?workspaceId=${WS_ID}&limit=8`)
            if (res.ok) {
                const d = await res.json() as { items: Task[] }
                setTasks(d.items)
            }
        } catch { /* silent */ }
    }, [])

    const fetchChannels = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/channels?workspaceId=${WS_ID}`)
            if (res.ok) {
                const d = await res.json() as { items: ChannelHealth[] }
                setChannels(d.items ?? [])
            }
        } catch { /* silent */ }
    }, [])

    const manualRefresh = useCallback(async () => {
        setRefreshing(true)
        await Promise.all([fetchSummary(), fetchActivity(), fetchChannels()])
        setRefreshing(false)
    }, [fetchSummary, fetchActivity, fetchChannels])

    // Initial load
    useEffect(() => {
        void fetchSummary()
        void fetchActivity()
        void fetchChannels()
    }, [fetchSummary, fetchActivity, fetchChannels])

    // Poll summary every 15s
    useEffect(() => {
        const t = setInterval(() => void fetchSummary(), POLL_MS)
        return () => clearInterval(t)
    }, [fetchSummary])

    // Poll activity every 10s
    useEffect(() => {
        const t = setInterval(() => void fetchActivity(), ACTIVITY_POLL_MS)
        return () => clearInterval(t)
    }, [fetchActivity])

    // Poll channel health every 30s
    useEffect(() => {
        const t = setInterval(() => void fetchChannels(), CHANNEL_POLL_MS)
        return () => clearInterval(t)
    }, [fetchChannels])

    // SSE for real-time task updates
    useEffect(() => {
        if (!WS_ID || typeof window === 'undefined') return
        const url = `${API_BASE}/api/sse?workspaceId=${WS_ID}`
        try {
            const es = new EventSource(url)
            esRef.current = es

            es.onmessage = (e) => {
                try {
                    const event = JSON.parse(e.data as string) as { type: string }
                    // Re-fetch on any task or agent event
                    if (event.type === 'task:update' || event.type === 'agent:status') {
                        void fetchSummary()
                        void fetchActivity()
                    }
                } catch { /* malformed SSE */ }
            }

            es.onerror = () => {
                es.close()
                esRef.current = null
            }

            return () => {
                es.close()
                esRef.current = null
            }
        } catch {
            return undefined
        }
    }, [fetchSummary, fetchActivity])

    // ── Derived values ────────────────────────────────────────────────────────

    const running = summary?.agent.activeTasks ?? 0
    const queued = summary?.agent.queuedTasks ?? 0
    const weekCost = summary?.cost.thisWeek ?? 0
    const ceiling = summary?.cost.ceiling ?? 10
    const pct = summary?.cost.percentUsed ?? 0
    const totalTasks = summary?.tasks.total ?? 0
    const stepsThisWeek = summary?.steps.thisWeek ?? 0
    const isRunning = summary?.agent.status === 'running'

    const cards = [
        {
            id: 'agent',
            title: 'Agent Status',
            subtitle: isRunning ? 'Running' : (summary ? 'Idle' : 'Connecting…'),
            icon: Activity,
            accent: isRunning ? 'from-green-500 to-emerald-600' : 'from-emerald-500 to-emerald-600',
            dot: isRunning ? 'bg-green-400 animate-pulse' : 'bg-zinc-600',
            content: !WS_ID
                ? <Link href="/settings/ai-providers" className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors">Configure AI provider <ArrowRight className="h-3 w-3" /></Link>
                : running > 0
                    ? `${running} task${running !== 1 ? 's' : ''} running · ${queued} queued`
                    : queued > 0
                        ? `${queued} task${queued !== 1 ? 's' : ''} queued`
                        : 'Idle — waiting for tasks',
        },
        {
            id: 'tasks',
            title: 'Tasks',
            subtitle: summary ? `${totalTasks} total` : '…',
            icon: Zap,
            accent: 'from-amber-500 to-orange-600',
            dot: (running + queued) > 0 ? 'bg-amber-400 animate-pulse' : 'bg-zinc-600',
            content: !summary
                ? 'Loading…'
                : totalTasks === 0
                    ? <span className="text-zinc-600">No tasks yet — send a message below</span>
                    : Object.entries(summary.tasks.byStatus)
                        .map(([s, n]) => `${n} ${s}`)
                        .join(' · '),
        },
        {
            id: 'channels',
            title: 'Channels',
            subtitle: channels.length > 0 ? `${channels.filter(c => c.status === 'active').length} active` : 'Monitoring',
            icon: MessageSquare,
            accent: 'from-blue-500 to-indigo-600',
            dot: channels.some(c => c.status === 'active') ? 'bg-blue-400 animate-pulse' : 'bg-zinc-600',
            content: channels.length === 0
                ? <Link href="/settings/channels" className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors">Add a channel <ArrowRight className="h-3 w-3" /></Link>
                : channels.map(c => c.name).join(' · '),
        },
        {
            id: 'cost',
            title: 'API Cost',
            subtitle: 'This week',
            icon: DollarSign,
            accent: pct > 80 ? 'from-red-500 to-rose-600' : pct > 50 ? 'from-amber-500 to-orange-600' : 'from-violet-500 to-purple-600',
            dot: pct > 80 ? 'bg-red-400 animate-pulse' : 'bg-zinc-600',
            content: !summary
                ? 'Loading…'
                : `$${weekCost.toFixed(4)} / $${ceiling.toFixed(2)} (${Math.round(pct)}% used)`,
        },
        {
            id: 'steps',
            title: 'Steps This Week',
            subtitle: 'Agent executions',
            icon: Clock,
            accent: 'from-cyan-500 to-teal-600',
            dot: 'bg-zinc-600',
            content: summary
                ? `${stepsThisWeek.toLocaleString()} steps · ${(summary.steps.tokensThisWeek / 1000).toFixed(1)}k tokens`
                : 'Loading…',
        },
        {
            id: 'projects',
            title: 'Projects',
            subtitle: 'Sprints',
            icon: GitBranch,
            accent: 'from-pink-500 to-rose-600',
            dot: 'bg-zinc-600',
            content: <Link href="/projects" className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors">View Projects <ArrowRight className="h-3 w-3" /></Link>,
        },
    ]

    return (
        <div className="flex flex-col gap-6">
            {/* Cards */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-zinc-600">
                        {lastUpdated ? `Updated ${timeAgo(lastUpdated.toISOString())}` : 'Loading…'}
                    </p>
                    <button
                        onClick={() => void manualRefresh()}
                        disabled={refreshing}
                        className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {cards.map((card) => {
                        const Icon = card.icon
                        return (
                            <div
                                key={card.id}
                                className="card-glow group rounded-xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm transition-all hover:border-zinc-700"
                            >
                                <div className="flex items-center gap-3 border-b border-zinc-800/50 p-4">
                                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${card.accent} text-white shadow-lg`}>
                                        <Icon className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-[13px] font-semibold">{card.title}</h3>
                                        <div className="flex items-center gap-1.5">
                                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${card.dot}`} />
                                            <p className="text-[11px] text-zinc-500">{card.subtitle}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="px-4 py-5">
                                    <p className="text-sm text-zinc-400 flex items-center gap-1">{card.content}</p>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Task feed */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
                <div className="border-b border-zinc-800/50 px-4 py-3 flex items-center justify-between">
                    <h2 className="text-[13px] font-semibold">Recent Tasks</h2>
                    {(running + queued) > 0 && (
                        <span className="flex items-center gap-1.5 text-[11px] text-blue-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                            {running} running
                        </span>
                    )}
                </div>
                {tasks.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                        <p className="text-sm text-zinc-600">No tasks yet. Send a message below to get started.</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-zinc-800/50">
                        {tasks.map((task) => (
                            <li key={task.id} className="flex items-start gap-3 px-4 py-3">
                                <span className={`mt-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_COLORS[task.status] ?? STATUS_COLORS.queued}`}>
                                    {task.status}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] text-zinc-200">
                                        {task.outcomeSummary ?? `${task.type} task via ${task.source}`}
                                    </p>
                                    <div className="mt-0.5 flex gap-2 text-[11px] text-zinc-500">
                                        <span>{task.type}</span>
                                        <span>·</span>
                                        <span>{timeAgo(task.createdAt)}</span>
                                        {task.qualityScore != null && (
                                            <>
                                                <span>·</span>
                                                <span>Q {Math.round(task.qualityScore * 100)}%</span>
                                            </>
                                        )}
                                        {task.costUsd != null && task.costUsd > 0 && (
                                            <>
                                                <span>·</span>
                                                <span>${task.costUsd.toFixed(4)}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    )
}
