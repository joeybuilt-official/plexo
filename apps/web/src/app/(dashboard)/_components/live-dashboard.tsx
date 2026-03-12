// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

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
    Users,
} from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { StatusBadge, cn } from '@plexo/ui'

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
    ensemble?: {
        total: number
        byMode: Record<string, number>
        avgDelta: number | null
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

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
const POLL_MS = 15_000
const ACTIVITY_POLL_MS = 10_000
const CHANNEL_POLL_MS = 30_000

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
            const res = await fetch(`${API_BASE}/api/v1/dashboard/summary?workspaceId=${WS_ID}`)
            if (res.ok) {
                setSummary(await res.json() as DashboardSummary)
                setLastUpdated(new Date())
            }
        } catch { /* silent */ }
    }, [WS_ID])

    const fetchActivity = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/v1/dashboard/activity?workspaceId=${WS_ID}&limit=8`)
            if (res.ok) {
                const d = await res.json() as { items: Task[] }
                setTasks(d.items)
            }
        } catch { /* silent */ }
    }, [WS_ID])

    const fetchChannels = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/v1/channels?workspaceId=${WS_ID}`)
            if (res.ok) {
                const d = await res.json() as { items: ChannelHealth[] }
                setChannels(d.items ?? [])
            }
        } catch { /* silent */ }
    }, [WS_ID])

    const manualRefresh = useCallback(async () => {
        setRefreshing(true)
        await Promise.all([fetchSummary(), fetchActivity(), fetchChannels()])
        setRefreshing(false)
    }, [fetchSummary, fetchActivity, fetchChannels])

    useEffect(() => {
        void fetchSummary()
        void fetchActivity()
        void fetchChannels()
    }, [fetchSummary, fetchActivity, fetchChannels])

    useEffect(() => {
        const t = setInterval(() => void fetchSummary(), POLL_MS)
        return () => clearInterval(t)
    }, [fetchSummary])

    useEffect(() => {
        const t = setInterval(() => void fetchActivity(), ACTIVITY_POLL_MS)
        return () => clearInterval(t)
    }, [fetchActivity])

    useEffect(() => {
        const t = setInterval(() => void fetchChannels(), CHANNEL_POLL_MS)
        return () => clearInterval(t)
    }, [fetchChannels])

    useEffect(() => {
        if (!WS_ID || typeof window === 'undefined') return
        const url = `${API_BASE}/api/v1/sse?workspaceId=${WS_ID}`
        try {
            const es = new EventSource(url)
            esRef.current = es
            es.onmessage = (e) => {
                try {
                    const event = JSON.parse(e.data as string) as { type: string }
                    if (event.type.startsWith('task_') || event.type.startsWith('agent_')) {
                        void fetchSummary()
                        void fetchActivity()
                    }
                } catch { /* skip */ }
            }
            es.onerror = () => { es.close(); esRef.current = null }
            return () => { es.close(); esRef.current = null }
        } catch { return undefined }
    }, [fetchSummary, fetchActivity])

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
            title: 'Neural Link',
            subtitle: isRunning ? 'Synchronized' : 'Quiescent',
            icon: Activity,
            accent: isRunning ? 'bg-azure/10 text-azure' : 'bg-surface-2 text-zinc-500',
            pulse: isRunning,
            content: !WS_ID
                ? <Link href="/settings/ai-providers" className="text-azure hover:underline">Link AI Provider</Link>
                : running > 0
                    ? `${running} active · ${queued} queued`
                    : 'System idle',
        },
        {
            id: 'tasks',
            title: 'Operations',
            subtitle: `${totalTasks} total`,
            icon: Zap,
            accent: 'bg-amber/10 text-amber',
            content: Object.entries(summary?.tasks.byStatus ?? {})
                .map(([s, n]) => `${n} ${s}`)
                .slice(0, 3)
                .join(' · ') || 'No operations',
        },
        {
            id: 'cost',
            title: 'Fiscal Load',
            subtitle: `$${weekCost.toFixed(3)} used`,
            icon: DollarSign,
            accent: pct > 80 ? 'bg-red/10 text-red' : 'bg-azure/10 text-azure',
            content: `${Math.round(pct)}% of $${ceiling.toFixed(2)} quota`,
        },
        {
            id: 'performance',
            title: 'Throughput',
            subtitle: 'Last 7 days',
            icon: Clock,
            accent: 'bg-surface-2 text-zinc-500',
            content: summary ? `${stepsThisWeek.toLocaleString()} steps executed` : 'Calculating...',
        },
    ]

    return (
        <div className="flex flex-col gap-8">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="h-1.5 w-1.5 rounded-full bg-azure animate-pulse shadow-[0_0_8px_var(--color-azure)]" />
                    <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-text-primary">Live Telemetry</h3>
                </div>
                <div className="flex items-center gap-4">
                    {lastUpdated && <span className="text-[10px] font-mono text-zinc-600">UPDT_{timeAgo(lastUpdated.toISOString()).toUpperCase()}</span>}
                    <button
                        onClick={() => void manualRefresh()}
                        disabled={refreshing}
                        className="text-text-muted hover:text-white transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {cards.map((card) => {
                    const Icon = card.icon
                    return (
                        <div key={card.id} className="rounded-2xl border border-border bg-surface-1/40 p-4 shadow-sm group hover:border-azure/20 transition-all">
                            <div className="flex items-center gap-3 mb-3">
                                <div className={cn("flex h-8 w-8 items-center justify-center rounded-xl", card.accent)}>
                                    <Icon className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h4 className="text-[11px] font-black uppercase tracking-widest text-text-primary">{card.title}</h4>
                                    <p className="text-[10px] font-mono text-text-muted truncate">{card.subtitle}</p>
                                </div>
                            </div>
                            <div className="text-sm font-medium text-text-secondary group-hover:text-white transition-colors">{card.content}</div>
                        </div>
                    )
                })}
            </div>

            <div className="rounded-2xl border border-border bg-black/20 overflow-hidden shadow-xl">
                <div className="border-b border-border/50 px-5 py-4 bg-surface-1/40 flex items-center justify-between">
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-text-primary">Recent Signal Packets</h4>
                    <Link href="/tasks" className="text-[10px] font-bold text-azure hover:text-white transition-colors flex items-center gap-1.5">
                        VIEW ALL <ArrowRight className="h-3 w-3" />
                    </Link>
                </div>
                <div className="divide-y divide-border/30">
                    {tasks.length === 0 ? (
                        <div className="p-8 text-center text-xs text-text-muted italic">Awaiting first transmission...</div>
                    ) : (
                        tasks.map((task) => (
                            <div key={task.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-1/40 transition-colors">
                                <StatusBadge status={task.status as any} size="sm" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-text-secondary">{task.outcomeSummary ?? `${task.type} unit`}</p>
                                    <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-zinc-600">
                                        <span className="uppercase">{task.type}</span>
                                        <span>·</span>
                                        <span>{timeAgo(task.createdAt).toUpperCase()}</span>
                                    </div>
                                </div>
                                <Link href={`/tasks/${task.id}`} className="p-2 rounded-lg border border-border text-zinc-600 hover:text-white hover:border-azure/30 transition-all">
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </Link>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
