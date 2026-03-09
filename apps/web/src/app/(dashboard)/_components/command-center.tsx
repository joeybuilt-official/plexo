// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
    Zap,
    AlertTriangle,
    ShieldAlert,
    FolderOpen,
    ArrowRight,
    ChevronRight,
    ExternalLink,
    CheckCircle2,
    Loader2,
    Clock,
    Activity,
} from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { getRuntimeContext } from '@plexo/ui/lib/runtime'

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
    projectId: string | null
    context?: { description?: string } | null
}

interface Sprint {
    id: string
    repo: string
    request: string
    status: string
    createdAt: string
    completedAt: string | null
}

interface Approval {
    id: string
    workspaceId: string
    taskId: string
    operation: string
    riskLevel: string
    context?: Record<string, unknown>
    createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
const POLL_MS = 15_000

function timeAgo(iso: string): string {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
}

function getGreeting(): string {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
}

// ── Hero stat tile ────────────────────────────────────────────────────────────

function HeroStat({ label, value, accent, icon: Icon, href, pulse }: {
    label: string
    value: number
    accent: string
    icon: React.ElementType
    href: string
    pulse?: boolean
}) {
    return (
        <Link
            href={href}
            className="group flex flex-col items-center gap-2 rounded-xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm px-4 py-4 transition-all hover:border-zinc-700 hover:bg-zinc-900/60 min-w-0 flex-1"
        >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br ${accent} text-white shadow-lg ${pulse ? 'animate-pulse' : ''}`}>
                <Icon className="h-4 w-4" />
            </div>
            <span className="text-2xl font-bold tabular-nums text-zinc-100">{value}</span>
            <span className="text-[11px] font-medium text-zinc-500 group-hover:text-zinc-400 transition-colors text-center leading-tight">{label}</span>
        </Link>
    )
}

// ── Attention item ────────────────────────────────────────────────────────────

function AttentionItem({ icon: Icon, iconColor, label, meta, href, actionLabel }: {
    icon: React.ElementType
    iconColor: string
    label: string
    meta: string
    href: string
    actionLabel: string
}) {
    return (
        <Link
            href={href}
            className="flex items-center gap-3 rounded-lg px-3 py-3 md:py-2.5 min-h-[44px] transition-colors hover:bg-zinc-800/40 group shrink-0"
        >
            <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconColor}`}>
                <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-zinc-200">{label}</p>
                <p className="truncate text-[11px] text-zinc-600">{meta}</p>
            </div>
            <span className="shrink-0 ml-2 flex h-9 items-center justify-center gap-1 text-[11px] font-medium text-zinc-600 group-hover:text-zinc-400 transition-colors">
                {actionLabel}
                <ChevronRight className="h-3 w-3" />
            </span>
        </Link>
    )
}

// ── Active work item ──────────────────────────────────────────────────────────

function ActiveWorkItem({ task }: { task: Task }) {
    const description = task.outcomeSummary ?? task.context?.description ?? `${task.type} task via ${task.source}`
    const isRunning = task.status === 'running' || task.status === 'claimed'

    return (
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-3 py-3 md:py-2.5 group shrink-0 min-h-[44px]">
            <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
                    {isRunning ? (
                        <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                    ) : (
                        <Clock className="h-4 w-4 text-amber-400" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-zinc-200">{description}</p>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-600">
                        <span className={`inline-flex items-center gap-1 ${isRunning ? 'text-blue-400' : 'text-amber-400'}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-blue-400 animate-pulse' : 'bg-amber-400'}`} />
                            {task.status}
                        </span>
                        <span>·</span>
                        <span>{task.type}</span>
                        <span>·</span>
                        <span>{timeAgo(task.createdAt)}</span>
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 md:gap-1.5 shrink-0 w-full md:w-auto mt-2 md:mt-0">
                {task.projectId && (
                    <Link
                        href={`/projects/${task.projectId}`}
                        className="flex items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 md:px-2 md:py-0.5 min-h-[36px] min-w-[60px] md:min-h-0 md:min-w-0 text-xs md:text-[10px] font-medium text-zinc-500 transition-all hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-400 flex-1 md:flex-initial"
                    >
                        Project
                    </Link>
                )}
                <Link
                    href={`/tasks/${task.id}`}
                        className="flex items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 md:px-2 md:py-0.5 min-h-[36px] min-w-[60px] md:min-h-0 md:min-w-0 text-xs md:text-[10px] font-medium text-zinc-500 transition-all hover:border-zinc-500/40 hover:bg-zinc-700/40 hover:text-zinc-300 flex-1 md:flex-initial"
                >
                    Task
                </Link>
            </div>
        </div>
    )
}

// ── Project card ──────────────────────────────────────────────────────────────

function ProjectCard({ sprint, tasks: sprintTasks }: { sprint: Sprint; tasks: Task[] }) {
    const linked = sprintTasks.filter(t => t.source === 'dashboard' || true) // all tasks linked to this sprint
    const done = linked.filter(t => t.status === 'complete').length
    const running = linked.filter(t => t.status === 'running' || t.status === 'claimed').length
    const blocked = linked.filter(t => t.status === 'blocked').length
    const total = linked.length || 1

    const STATUS_BG: Record<string, string> = {
        planning: 'bg-amber-500/20 text-amber-400',
        running: 'bg-blue-500/20 text-blue-400',
        complete: 'bg-emerald-500/20 text-emerald-400',
        failed: 'bg-red-500/20 text-red-400',
    }

    return (
        <Link
            href={`/projects/${sprint.id}`}
            className="flex flex-col rounded-xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900/60 min-w-[280px] md:min-w-[240px] max-w-[320px] flex-1 shrink-0 snap-center md:snap-start"
        >
            <div className="flex items-center justify-between mb-2">
                <h4 className="text-[13px] font-medium text-zinc-200 truncate">{sprint.repo || sprint.request.slice(0, 40)}</h4>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${STATUS_BG[sprint.status] ?? STATUS_BG.planning}`}>
                    {sprint.status}
                </span>
            </div>
            <p className="text-[11px] text-zinc-500 truncate mb-3">{sprint.request}</p>

            {/* Progress bar */}
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                {done > 0 && (
                    <div className="bg-emerald-500 transition-all" style={{ width: `${(done / total) * 100}%` }} />
                )}
                {running > 0 && (
                    <div className="bg-blue-500 transition-all" style={{ width: `${(running / total) * 100}%` }} />
                )}
                {blocked > 0 && (
                    <div className="bg-red-500 transition-all" style={{ width: `${(blocked / total) * 100}%` }} />
                )}
            </div>
            <div className="mt-2 flex gap-3 text-[10px] text-zinc-600">
                {done > 0 && <span className="text-emerald-500">{done} done</span>}
                {running > 0 && <span className="text-blue-400">{running} active</span>}
                {blocked > 0 && <span className="text-red-400">{blocked} blocked</span>}
                {linked.length === 0 && <span>No tasks yet</span>}
            </div>
        </Link>
    )
}

// ── Completed item ────────────────────────────────────────────────────────────

function CompletedItem({ task }: { task: Task }) {
    const label = task.outcomeSummary ?? `${task.type} task via ${task.source}`
    return (
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-3 py-3 md:py-2.5 group shrink-0 min-h-[44px]">
            <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-zinc-300">{label}</p>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-600">
                        <span>{task.type}</span>
                        {task.completedAt && <><span>·</span><span>{timeAgo(task.completedAt)}</span></>}
                        {task.qualityScore != null && <><span>·</span><span className="text-zinc-500">Q {Math.round(task.qualityScore * 100)}%</span></>}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 md:gap-1.5 shrink-0 w-full md:w-auto mt-2 md:mt-0">
                {task.projectId && (
                    <Link
                        href={`/projects/${task.projectId}`}
                        className="flex items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 md:px-2 md:py-0.5 min-h-[36px] min-w-[60px] md:min-h-0 md:min-w-0 text-xs md:text-[10px] font-medium text-zinc-500 transition-all hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-400 flex-1 md:flex-initial"
                    >
                        Project
                    </Link>
                )}
                <Link
                    href={`/tasks/${task.id}`}
                    className="flex items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 md:px-2 md:py-0.5 min-h-[36px] min-w-[60px] md:min-h-0 md:min-w-0 text-xs md:text-[10px] font-medium text-zinc-500 transition-all hover:border-zinc-500/40 hover:bg-zinc-700/40 hover:text-zinc-300 flex-1 md:flex-initial"
                >
                    Task
                </Link>
            </div>
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

export function CommandCenter() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [summary, setSummary] = useState<DashboardSummary | null>(null)
    const [allTasks, setAllTasks] = useState<Task[]>([])
    const [sprints, setSprints] = useState<Sprint[]>([])
    const [approvals, setApprovals] = useState<Approval[]>([])
    const [loaded, setLoaded] = useState(false)
    const esRef = useRef<EventSource | null>(null)

    const fetchAll = useCallback(async () => {
        if (!WS_ID) return

        const [summaryRes, activityRes, sprintsRes, approvalsRes] = await Promise.allSettled([
            fetch(`${API_BASE}/api/v1/dashboard/summary?workspaceId=${WS_ID}`),
            fetch(`${API_BASE}/api/v1/dashboard/activity?workspaceId=${WS_ID}&limit=50`),
            fetch(`${API_BASE}/api/v1/sprints?workspaceId=${WS_ID}`),
            fetch(`${API_BASE}/api/v1/approvals?workspaceId=${WS_ID}`),
        ])

        if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
            setSummary(await summaryRes.value.json() as DashboardSummary)
        }
        if (activityRes.status === 'fulfilled' && activityRes.value.ok) {
            const d = await activityRes.value.json() as { items: Task[] }
            setAllTasks(d.items)
        }
        if (sprintsRes.status === 'fulfilled' && sprintsRes.value.ok) {
            const d = await sprintsRes.value.json() as { items: Sprint[] }
            setSprints(d.items ?? [])
        }
        if (approvalsRes.status === 'fulfilled' && approvalsRes.value.ok) {
            const d = await approvalsRes.value.json() as { items: Approval[] }
            setApprovals(d.items ?? [])
        }
        setLoaded(true)
    }, [WS_ID])

    // Initial load
    useEffect(() => { void fetchAll() }, [fetchAll])

    // Polling
    useEffect(() => {
        const t = setInterval(() => void fetchAll(), POLL_MS)
        return () => clearInterval(t)
    }, [fetchAll])

    // SSE for real-time updates
    useEffect(() => {
        if (!WS_ID || typeof window === 'undefined') return
        try {
            const es = new EventSource(`${API_BASE}/api/v1/sse?workspaceId=${WS_ID}`)
            esRef.current = es
            es.onmessage = () => { void fetchAll() }
            es.onerror = () => { es.close(); esRef.current = null }
            return () => { es.close(); esRef.current = null }
        } catch { return undefined }
    }, [WS_ID, fetchAll])

    // ── Derived data ──────────────────────────────────────────────────────────

    const activeTasks = allTasks.filter(t => t.status === 'running' || t.status === 'claimed' || t.status === 'queued')
    const blockedTasks = allTasks.filter(t => t.status === 'blocked')
    const completedTasks = allTasks.filter(t => t.status === 'complete').slice(0, 5)
    const runningTasks = allTasks.filter(t => t.status === 'running' || t.status === 'claimed')
    const queuedTasks = allTasks.filter(t => t.status === 'queued')
    const activeWork = [...runningTasks, ...queuedTasks].slice(0, 5)
    const activeSprints = sprints.filter(s => s.status === 'planning' || s.status === 'running')

    // Attention items: blockers + approvals
    const attentionItems: { id: string; icon: React.ElementType; iconColor: string; label: string; meta: string; href: string; actionLabel: string; priority: number }[] = []

    for (const approval of approvals.slice(0, 3)) {
        attentionItems.push({
            id: `approval-${approval.id}`,
            icon: ShieldAlert,
            iconColor: 'bg-amber-500/20 text-amber-400',
            label: `Approval needed: ${approval.operation}`,
            meta: `${approval.riskLevel} risk · ${timeAgo(approval.createdAt)}`,
            href: `/approvals`,
            actionLabel: 'Review',
            priority: 1,
        })
    }

    for (const task of blockedTasks.slice(0, 3)) {
        // Detect known root causes and route directly to the fix
        const outcome = task.outcomeSummary ?? ''
        let fixHref = `/tasks/${task.id}`
        let fixLabel = 'Fix'
        if (/no ai credential/i.test(outcome)) {
            fixHref = `/settings/ai-providers`
            fixLabel = 'Configure'
        } else if (/rate limit/i.test(outcome)) {
            fixHref = `/settings/ai-providers`
            fixLabel = 'Review'
        } else if (/no channel/i.test(outcome)) {
            fixHref = `/settings/connections`
            fixLabel = 'Fix'
        }

        attentionItems.push({
            id: `blocked-${task.id}`,
            icon: AlertTriangle,
            iconColor: 'bg-red-500/20 text-red-400',
            label: outcome || `Blocked: ${task.type} task`,
            meta: `${task.source} · ${timeAgo(task.createdAt)}`,
            href: fixHref,
            actionLabel: fixLabel,
            priority: 2,
        })
    }

    attentionItems.sort((a, b) => a.priority - b.priority)

    // ── Skeleton ──────────────────────────────────────────────────────────────

    if (!loaded) {
        return (
            <div className="flex flex-col gap-6 animate-pulse">
                <div className="h-8 w-48 rounded bg-zinc-800/50" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} className="h-[100px] rounded-xl bg-zinc-800/30 border border-zinc-800/50" />
                    ))}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                    <div className="lg:col-span-3 h-[180px] rounded-xl bg-zinc-800/30 border border-zinc-800/50" />
                    <div className="lg:col-span-2 h-[180px] rounded-xl bg-zinc-800/30 border border-zinc-800/50" />
                </div>
            </div>
        )
    }

    const runtime = typeof window !== 'undefined' ? getRuntimeContext() : 'browser'

    const hasAttention = attentionItems.length > 0
    const hasActiveWork = activeWork.length > 0
    const hasProjects = activeSprints.length > 0
    const hasCompletedRecently = completedTasks.length > 0

    // ── Unified Desktop & Mobile Optimized Dashboard ──
    const allFeedTasks = allTasks.slice(0, 30) // Limit feed so it doesn't dominate

    if (runtime === 'tauri') {
        // Desktop Layout: Agent Status Card + Chat Side by Side
        return (
            <div className="flex flex-col md:flex-row gap-6 h-[calc(100vh-120px)]">
                {/* Status Card */}
                <div className="flex flex-col w-1/3 min-w-[300px] gap-4">
                    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-5 shadow-lg flex flex-col items-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 text-indigo-400 mb-4 ring-1 ring-inset ring-indigo-500/30">
                            <Zap className="h-8 w-8" />
                        </div>
                        <h2 className="text-lg font-bold text-zinc-100 mb-1">Plexo</h2>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium mb-6">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            Online & Ready
                        </span>

                        <div className="w-full grid grid-cols-2 gap-2 text-center text-sm">
                            <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/50">
                                <div className="font-bold text-zinc-100">{activeTasks.length}</div>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">Active Tasks</div>
                            </div>
                            <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/50">
                                <div className="font-bold text-zinc-100">{approvals.length}</div>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">Approvals</div>
                            </div>
                        </div>
                    </div>
                    {/* Embedded task list if needed */}
                    {hasAttention && (
                        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4">
                            <h3 className="text-[13px] font-semibold text-amber-400 mb-3 flex items-center gap-2">
                                <ShieldAlert className="h-4 w-4" /> Attention Required
                            </h3>
                            <div className="divide-y divide-zinc-800/30">
                                {attentionItems.map(item => (
                                    <AttentionItem key={item.id} {...item} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                {/* Chat Frame */}
                <div className="flex-1 rounded-xl border border-zinc-800/60 bg-zinc-950 flex overflow-hidden">
                    <iframe src="/chat" className="w-full h-full border-0" />
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6 pb-20 md:pb-4">
            {/* Top Row: Hero Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <HeroStat
                    label="Active Tasks"
                    value={activeTasks.length}
                    accent="from-blue-500 to-indigo-600"
                    icon={Zap}
                    href="/tasks"
                    pulse={runningTasks.length > 0}
                />
                <HeroStat
                    label="Blocked"
                    value={blockedTasks.length}
                    accent={blockedTasks.length > 0 ? 'from-red-500 to-rose-600' : 'from-zinc-600 to-zinc-700'}
                    icon={AlertTriangle}
                    href="/tasks"
                />
                <HeroStat
                    label="Awaiting Approval"
                    value={approvals.length}
                    accent={approvals.length > 0 ? 'from-amber-500 to-orange-600' : 'from-zinc-600 to-zinc-700'}
                    icon={ShieldAlert}
                    href="/approvals"
                />
                <HeroStat
                    label="Active Projects"
                    value={activeSprints.length}
                    accent={activeSprints.length > 0 ? 'from-violet-500 to-purple-600' : 'from-zinc-600 to-zinc-700'}
                    icon={FolderOpen}
                    href="/projects"
                />
            </div>

            {/* Main Layout Grid */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                
                {/* Left Column: Essential Workflow */}
                <div className="xl:col-span-2 flex flex-col gap-6">
                    {/* Attention Required */}
                    {hasAttention && (
                        <div className="rounded-xl border border-red-500/20 bg-zinc-900/40 backdrop-blur-sm shadow-sm overflow-hidden">
                            <div className="flex items-center justify-between border-b border-red-500/10 px-4 py-3 bg-red-500/5">
                                <div className="flex items-center gap-2">
                                    <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                                    <h3 className="text-[13px] font-semibold text-red-500">Attention Required</h3>
                                </div>
                                <span className="text-[11px] font-medium text-red-400 bg-red-500/10 px-2.5 py-0.5 rounded-full">{attentionItems.length} item{attentionItems.length !== 1 ? 's' : ''}</span>
                            </div>
                            <div className="divide-y divide-zinc-800/30 p-1">
                                {attentionItems.map(item => (
                                    <AttentionItem
                                        key={item.id}
                                        icon={item.icon}
                                        iconColor={item.iconColor}
                                        label={item.label}
                                        meta={item.meta}
                                        href={item.href}
                                        actionLabel={item.actionLabel}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Active Work */}
                    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm shadow-sm overflow-hidden min-h-[140px] flex flex-col">
                            <div className="flex items-center justify-between border-b border-zinc-800/50 px-4 py-3 bg-zinc-950/30">
                                <div className="flex items-center gap-2">
                                    <div className={`h-1.5 w-1.5 rounded-full ${hasActiveWork ? 'bg-blue-400 animate-pulse' : 'bg-emerald-400'}`} />
                                    <h3 className="text-[13px] font-semibold text-zinc-200">Current Focus</h3>
                                </div>
                                <Link href="/tasks" className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 group">
                                    <span className="hidden sm:inline">View Tasks</span> <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                                </Link>
                            </div>
                            {hasActiveWork ? (
                                <div className="divide-y divide-zinc-800/30 p-1">
                                    {activeWork.map(task => (
                                        <ActiveWorkItem key={task.id} task={task} />
                                    ))}
                                </div>
                            ) : (
                                <div className="p-8 text-center flex flex-col items-center flex-1 justify-center">
                                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 text-emerald-400 mb-3 border border-emerald-500/20">
                                        <CheckCircle2 className="h-6 w-6" />
                                    </div>
                                    <h4 className="text-sm font-medium text-zinc-300 mb-1">Queue Empty</h4>
                                    <p className="text-[11px] text-zinc-500">Your agent is online and awaiting instructions.</p>
                                </div>
                            )}
                        </div>

                    {/* Projects Overview */}
                    {hasProjects && (
                        <div>
                            <div className="flex items-center justify-between mb-3 px-1">
                                <h3 className="text-[13px] font-semibold text-zinc-300">Active Projects</h3>
                                <Link href="/projects" className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 group">
                                    View all <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                                </Link>
                            </div>
                            <div className="flex flex-wrap sm:flex-nowrap gap-3">
                                {activeSprints.slice(0, 3).map(sprint => (
                                    <ProjectCard
                                        key={sprint.id}
                                        sprint={sprint}
                                        tasks={allTasks.filter(t => t.source === sprint.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Right Column: Recent Activity Feed */}
                <div className="xl:col-span-1 flex flex-col h-[350px] xl:h-[450px]">
                    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm shadow-sm flex flex-col h-full overflow-hidden">
                        <div className="flex items-center justify-between border-b border-zinc-800/50 px-4 py-3 shrink-0 bg-zinc-950/30">
                            <div className="flex items-center gap-2">
                                <Activity className="h-3.5 w-3.5 text-zinc-400" />
                                <h3 className="text-[12px] font-semibold text-zinc-200 uppercase tracking-widest">Recent Activity</h3>
                            </div>
                            <span className="flex h-4 items-center justify-center rounded-full bg-zinc-800/50 px-2 text-[9px] font-medium uppercase tracking-wider text-zinc-400">
                                {allFeedTasks.length} events
                            </span>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-1 custom-scrollbar">
                            {allFeedTasks.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-[11px] text-zinc-500">
                                    No activity yet.
                                </div>
                            ) : (
                                <div className="divide-y divide-zinc-800/30">
                                    {allFeedTasks.map(t => (
                                        t.status === 'complete' ? <CompletedItem key={t.id} task={t} /> : <ActiveWorkItem key={t.id} task={t} />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    )

}
