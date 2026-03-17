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
    CheckCircle2,
    XCircle,
    Clock,
    Activity,
    Layers,
    TrendingUp,
    DollarSign,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { getRuntimeContext } from '@plexo/ui/lib/runtime'
import { PlexoMark } from '@web/components/plexo-logo'
import { getCategoryDef } from '@web/lib/project-categories'
import { StatusBadge, CategoryBadge, cn } from '@plexo/ui'

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
    repo: string | null
    category: string
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

interface AttentionItem {
    id: string
    icon: LucideIcon
    iconColor: string
    label: string
    meta: string
    href: string
    actionLabel: string
    priority: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
const POLL_MS = 15_000

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeroStat({ label, value, accent, icon: Icon, href, pulse }: {
    label: string
    value: string | number
    accent: string
    icon: React.ElementType
    href: string
    pulse?: boolean
}) {
    return (
        <Link
            id={`dashboard-card-${label.toLowerCase().replace(/\s+/g, '-')}`}
            href={href}
            className="group flex flex-col gap-1 rounded-2xl border border-border/60 bg-surface-1/40 backdrop-blur-md p-4 transition-all hover:border-azure/30 hover:bg-surface-2/40 shadow-sm"
        >
            <div className="flex items-center justify-between mb-1">
                <div className={cn("flex h-8 w-8 items-center justify-center rounded-xl transition-all shadow-inner", accent, pulse && "animate-pulse ring-2 ring-azure/20")}>
                    <Icon className="h-4 w-4" />
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-text-muted group-hover:text-text-secondary transition-all opacity-0 group-hover:opacity-100" />
            </div>
            <div className="text-2xl font-bold tabular-nums text-text-primary tracking-tight transition-transform group-hover:translate-x-0.5">{value}</div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted transition-colors group-hover:text-text-secondary">{label}</div>
        </Link>
    )
}

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
            className="flex items-center gap-3 px-4 py-3 transition-all hover:bg-surface-2/40 group relative overflow-hidden"
        >
            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset ring-white/5", iconColor)}>
                <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary group-hover:text-white transition-colors">{label}</p>
                <p className="truncate text-[11px] text-zinc-500 font-mono">{meta}</p>
            </div>
            <div className="shrink-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-text-muted group-hover:text-azure transition-colors">
                {actionLabel}
                <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </Link>
    )
}

function ActiveWorkItem({ task }: { task: Task }) {
    const description = task.outcomeSummary ?? task.context?.description ?? `${task.type} task via ${task.source}`
    const isRunning = task.status === 'running' || task.status === 'claimed'

    return (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3.5 group/item transition-colors hover:bg-surface-1/60">
            <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 border border-border/50 group-hover/item:border-azure/30 transition-colors">
                    {isRunning ? (
                        <PlexoMark className="h-5 w-5" idle={false} working />
                    ) : (
                        <Clock className="h-4 w-4 text-amber" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary group-hover/item:text-white transition-colors leading-snug">{description}</p>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted mt-1 uppercase tracking-tight">
                        <StatusBadge status={task.status} size="sm" />
                        <span>·</span>
                        <span className="text-zinc-500">{task.type}</span>
                        <span>·</span>
                        <span className="text-zinc-600">{timeAgo(task.createdAt)}</span>
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                {task.projectId && (
                    <Link
                        href={`/projects/${task.projectId}`}
                        className="rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted hover:border-azure/30 hover:bg-azure/5 hover:text-white transition-all shadow-sm"
                    >
                        Project
                    </Link>
                )}
                <Link
                    href={`/tasks/${task.id}`}
                    className="rounded-lg border border-border bg-surface-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted hover:border-azure/40 hover:bg-surface-2 hover:text-white transition-all shadow-sm"
                >
                    View
                </Link>
            </div>
        </div>
    )
}

function ProjectCard({ sprint, tasks: sprintTasks }: { sprint: Sprint; tasks: Task[] }) {
    const linked = sprintTasks.filter(t => t.source === sprint.id || t.projectId === sprint.id || true)
    const done = linked.filter(t => t.status === 'complete').length
    const running = linked.filter(t => t.status === 'running' || t.status === 'claimed').length
    const total = linked.length || 1
    const progressPct = Math.round((done / total) * 100)
    const def = getCategoryDef(sprint.category)

    return (
        <Link
            href={`/projects/${sprint.id}`}
            className="group flex flex-col rounded-2xl border border-border/60 bg-surface-1/40 backdrop-blur-md p-4 transition-all hover:border-azure/30 hover:bg-surface-2/40 shadow-sm min-w-[260px] flex-1"
        >
            <div className="flex items-center justify-between mb-3">
                 <div className="flex flex-col min-w-0">
                    <h4 className="text-sm font-bold text-text-primary truncate transition-colors group-hover:text-white leading-tight">
                        {sprint.repo || sprint.request.slice(0, 32)}
                    </h4>
                    <span className="text-[10px] font-mono text-zinc-600 mt-0.5 uppercase tracking-tighter">PRJ_{sprint.id.slice(0, 8)}</span>
                 </div>
                 <StatusBadge status={sprint.status} size="sm" />
            </div>

            <div className="space-y-2 mt-auto">
                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    <span>Infiltration</span>
                    <span>{progressPct}%</span>
                </div>
                <div className="h-1 w-full rounded-full bg-surface-2 overflow-hidden ring-1 ring-inset ring-black/20">
                    <div 
                        className="h-full bg-gradient-to-r from-azure/40 to-azure transition-all duration-1000 shadow-[0_0_8px_var(--color-azure-dim)]" 
                        style={{ width: `${progressPct}%` }} 
                    />
                </div>
                <div className="flex items-center gap-3 pt-1">
                    <CategoryBadge label={def.label} iconName={def.icon} />
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-600">
                         {done > 0 && <span className="text-azure">{done} OK</span>}
                         {running > 0 && <span className="text-blue-400 animate-pulse">{running} OP</span>}
                    </div>
                </div>
            </div>
        </Link>
    )
}

function CompletedItem({ task }: { task: Task }) {
    const label = task.outcomeSummary ?? `${task.type} task via ${task.source}`
    return (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 group/item transition-colors hover:bg-surface-1/60">
            <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-azure/5 text-azure border border-azure/10 group-hover/item:border-azure/30 transition-colors">
                    <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-secondary group-hover/item:text-text-primary transition-colors leading-snug">{label}</p>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted mt-1 uppercase tracking-tight">
                        <span className="text-azure-dim font-bold">COMPLETED</span>
                        <span>·</span>
                        <span className="text-zinc-600">{timeAgo(task.completedAt || task.createdAt)}</span>
                        {task.qualityScore != null && (
                            <>
                                <span>·</span>
                                <span className="text-zinc-600">Q:{(task.qualityScore * 100).toFixed(0)}</span>
                            </>
                        )}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <Link
                    href={`/tasks/${task.id}`}
                    className="rounded-lg border border-border bg-surface-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted hover:border-azure/40 hover:bg-surface-2 hover:text-white transition-all shadow-sm"
                >
                    Review
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

    useEffect(() => { void fetchAll() }, [fetchAll])

    useEffect(() => {
        const t = setInterval(() => void fetchAll(), POLL_MS)
        return () => clearInterval(t)
    }, [fetchAll])

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

    const runningTasks = allTasks.filter(t => t.status === 'running' || t.status === 'claimed')
    const queuedTasks = allTasks.filter(t => t.status === 'queued')
    const activeTasksCount = runningTasks.length + queuedTasks.length
    const blockedTasks = allTasks.filter(t => t.status === 'blocked' || t.status === 'cancelled')
    const completedRecently = allTasks.filter(t => t.status === 'complete').slice(0, 10)
    const currentFocus = [...runningTasks, ...queuedTasks].slice(0, 8)
    const activeProjects = sprints.filter(s => ['planning', 'running', 'finalizing'].includes(s.status))

    const attentionItems: AttentionItem[] = []

    for (const approval of approvals.slice(0, 3)) {
        attentionItems.push({
            id: `approval-${approval.id}`,
            icon: ShieldAlert,
            iconColor: 'bg-amber-dim text-amber',
            label: `Authorization Required: ${approval.operation}`,
            meta: `${approval.riskLevel.toUpperCase()} RISK · ${timeAgo(approval.createdAt)}`,
            href: `/approvals`,
            actionLabel: 'Authorize',
            priority: 1,
        })
    }

    for (const task of blockedTasks.slice(0, 3)) {
        const outcome = task.outcomeSummary ?? ''
        let fixHref = `/tasks/${task.id}`
        let fixLabel = 'Intercept'
        if (/no ai credential/i.test(outcome)) {
            fixHref = `/settings/ai-providers`; fixLabel = 'Credential'
        } else if (/rate limit/i.test(outcome)) {
            fixHref = `/settings/ai-providers`; fixLabel = 'Review'
        } else if (/no channel/i.test(outcome)) {
            fixHref = `/settings/connections`; fixLabel = 'Gateway'
        }

        attentionItems.push({
            id: `blocked-${task.id}`,
            icon: task.status === 'cancelled' ? XCircle : AlertTriangle,
            iconColor: task.status === 'cancelled' ? 'bg-surface-2 text-zinc-400' : 'bg-red-dim text-red',
            label: outcome || `${task.status === 'cancelled' ? 'Termination' : 'Inhibition'}: ${task.type} unit`,
            meta: `${task.source.toUpperCase()} SOURCE · ${timeAgo(task.createdAt)}`,
            href: fixHref,
            actionLabel: fixLabel,
            priority: 2,
        })
    }

    attentionItems.sort((a, b) => a.priority - b.priority)

    if (!loaded) {
        return (
            <div className="flex flex-col gap-6 animate-pulse">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[0, 1, 2, 3].map(i => <div key={i} className="h-28 rounded-2xl bg-surface-2/30 border border-border" />)}
                </div>
                <div className="h-48 rounded-2xl bg-surface-2/30 border border-border" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2 h-72 rounded-2xl bg-surface-2/30 border border-border" />
                    <div className="md:col-span-1 h-72 rounded-2xl bg-surface-2/30 border border-border" />
                </div>
            </div>
        )
    }

    const runtime = typeof window !== 'undefined' ? getRuntimeContext() : 'browser'

    if (runtime === 'tauri') {
        return (
            <div className="flex flex-col gap-6 animate-in fade-in duration-700">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                     <div className="md:col-span-1 flex flex-col gap-6">
                        <div className="rounded-3xl border border-border bg-surface-1/40 backdrop-blur-xl p-8 flex flex-col items-center text-center shadow-2xl relative overflow-hidden">
                            <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-transparent via-azure to-transparent opacity-50" />
                            <div className="relative mb-6">
                                <div className="absolute inset-0 bg-azure blur-2xl opacity-20 animate-pulse" />
                                <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-azure/20 to-azure/5 text-azure ring-1 ring-inset ring-azure/30 shadow-inner">
                                    <PlexoMark className="h-10 w-10" working={runningTasks.length > 0} idle={runningTasks.length === 0} />
                                </div>
                            </div>
                            <h2 className="text-2xl font-black text-zinc-50 tracking-tighter mb-1">SYSTEM ONLINE</h2>
                            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-azure-dim text-azure text-[10px] font-bold uppercase tracking-widest mb-8 border border-azure/20 shadow-sm">
                                <span className="h-1.5 w-1.5 rounded-full bg-azure animate-pulse" />
                                Monitoring Layer Active
                            </div>

                            <div className="w-full grid grid-cols-2 gap-3">
                                <Link href="/tasks" className="p-4 bg-black/40 rounded-2xl border border-border/50 hover:border-azure/40 transition-all group">
                                    <div className="text-xl font-bold text-white group-hover:text-azure transition-colors">{activeTasksCount}</div>
                                    <div className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mt-1">Pending</div>
                                </Link>
                                <Link href="/approvals" className="p-4 bg-black/40 rounded-2xl border border-border/50 hover:border-amber/40 transition-all group">
                                    <div className="text-xl font-bold text-white group-hover:text-amber transition-colors">{approvals.length}</div>
                                    <div className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mt-1">Interlock</div>
                                </Link>
                            </div>
                        </div>

                        {attentionItems.length > 0 && (
                            <div className="rounded-2xl border border-red-500/20 bg-surface-1/20 overflow-hidden shadow-lg animate-in slide-in-from-left-4 duration-500">
                                <div className="flex items-center justify-between px-4 py-3 border-b border-red-500/10 bg-red/5">
                                    <span className="text-[10px] font-black text-red uppercase tracking-widest flex items-center gap-2">
                                        <ShieldAlert className="h-3 w-3" /> System Inhibitor
                                    </span>
                                    <span className="text-[10px] font-mono text-red/60">{attentionItems.length} EVT</span>
                                </div>
                                <div className="divide-y divide-border/30">
                                    {attentionItems.map(item => <AttentionItem key={item.id} {...item} />)}
                                </div>
                            </div>
                        )}
                     </div>

                     <div className="md:col-span-2 rounded-3xl border border-border bg-black/60 shadow-inner overflow-hidden flex flex-col h-[calc(100vh-160px)] ring-1 ring-inset ring-white/5">
                        <iframe src="/chat" className="w-full h-full border-0" />
                     </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6 pb-24 animate-in fade-in duration-500">
            {/* Command Header Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <HeroStat
                    label="Active Load"
                    value={activeTasksCount}
                    accent="bg-azure/10 text-azure"
                    icon={Zap}
                    href="/tasks"
                    pulse={runningTasks.length > 0}
                />
                <HeroStat
                    label="Inhibitors"
                    value={blockedTasks.length}
                    accent={blockedTasks.length > 0 ? 'bg-red/10 text-red' : 'bg-surface-2 text-text-muted'}
                    icon={AlertTriangle}
                    href="/tasks"
                />
                <HeroStat
                    label="Interlocks"
                    value={approvals.length}
                    accent={approvals.length > 0 ? 'bg-amber/10 text-amber' : 'bg-surface-2 text-text-muted'}
                    icon={ShieldAlert}
                    href="/approvals"
                />
                <HeroStat
                    label="Active Projects"
                    value={activeProjects.length}
                    accent="bg-azure/10 text-azure"
                    icon={Layers}
                    href="/projects"
                />
            </div>

            {/* Global Inhibitor Alert */}
            {attentionItems.length > 0 && (
                <div className="rounded-2xl border border-red-500/20 bg-surface-1/30 backdrop-blur-md shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
                    <div className="flex items-center justify-between border-b border-red-500/10 px-5 py-3.5 bg-red/10">
                        <div className="flex items-center gap-2.5">
                            <div className="h-2 w-2 rounded-full bg-red animate-pulse shadow-[0_0_8px_var(--color-red)]" />
                            <h3 className="text-xs font-black text-red uppercase tracking-[0.2em]">Manual Overload Required</h3>
                        </div>
                        <span className="text-[10px] font-mono text-red/60 bg-red-dim px-2 py-0.5 rounded-md border border-red/20">{attentionItems.length} EXCEPTIONS</span>
                    </div>
                    <div className="divide-y divide-border/20">
                        {attentionItems.map(item => <AttentionItem key={item.id} {...item} />)}
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
                {/* Workflow Column */}
                <div className="xl:col-span-2 flex flex-col gap-6">
                    {/* Active Work Engine */}
                    <div className="rounded-2xl border border-border bg-surface-1/40 backdrop-blur-md shadow-lg overflow-hidden flex flex-col min-h-[400px]">
                        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 bg-canvas/40">
                             <div className="flex items-center gap-3">
                                <div className={cn("h-1.5 w-1.5 rounded-full", currentFocus.length > 0 ? "bg-azure animate-pulse shadow-[0_0_8px_var(--color-azure)]" : "bg-text-muted")} />
                                <h3 className="text-xs font-black text-text-primary uppercase tracking-widest">Execution Engine</h3>
                             </div>
                             <Link href="/tasks" className="text-[10px] font-bold text-text-muted hover:text-white transition-all uppercase tracking-widest flex items-center gap-1.5 group">
                                Task Stream <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
                             </Link>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto divide-y divide-border/20 custom-scrollbar">
                            {currentFocus.length > 0 ? (
                                currentFocus.map(task => <ActiveWorkItem key={task.id} task={task} />)
                            ) : (
                                <div className="h-[340px] flex flex-col items-center justify-center p-8 text-center gap-4">
                                     <div className="h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-zinc-700 flex">
                                        <Zap className="h-8 w-8 opacity-20" />
                                     </div>
                                     <div className="max-w-xs">
                                        <p className="text-sm font-bold text-text-secondary uppercase tracking-wider mb-1">Grid Balanced</p>
                                        <p className="text-xs text-text-muted leading-relaxed">No active operations detected. The agent is in observation mode.</p>
                                     </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Project Grid */}
                    {activeProjects.length > 0 && (
                        <div className="flex flex-col gap-4">
                             <div className="flex items-center justify-between px-1">
                                <h3 className="text-xs font-black text-text-secondary uppercase tracking-widest">Macro Operations</h3>
                                <Link href="/projects" className="text-[10px] font-bold text-text-muted hover:text-white transition-all uppercase tracking-widest group flex items-center gap-1.5">
                                    All Projects <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
                                </Link>
                             </div>
                             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {activeProjects.slice(0, 3).map(sprint => (
                                    <ProjectCard 
                                        key={sprint.id} 
                                        sprint={sprint} 
                                        tasks={allTasks.filter(t => t.projectId === sprint.id)} 
                                    />
                                ))}
                             </div>
                        </div>
                    )}
                </div>

                {/* Audit Column */}
                <div className="xl:col-span-1">
                    <div className="rounded-2xl border border-border bg-surface-1/40 backdrop-blur-md shadow-lg overflow-hidden flex flex-col h-[600px] xl:sticky xl:top-24">
                        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 bg-canvas/40">
                             <div className="flex items-center gap-3">
                                <Activity className="h-4 w-4 text-text-muted" />
                                <h3 className="text-xs font-black text-text-primary uppercase tracking-widest">Audit Logs</h3>
                             </div>
                             <span className="text-[9px] font-bold text-azure bg-azure-dim px-2 py-0.5 rounded-full border border-azure/20">LIVE</span>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto divide-y divide-border/20 custom-scrollbar">
                            {allTasks.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center p-8 text-center text-text-muted italic text-[11px]">
                                    No data packets received.
                                </div>
                            ) : (
                                allTasks.slice(0, 15).map(t => (
                                    t.status === 'complete' ? <CompletedItem key={t.id} task={t} /> : <ActiveWorkItem key={t.id} task={t} />
                                ))
                            )}
                        </div>

                        <div className="p-4 border-t border-border/50 bg-canvas/40">
                            <Link 
                                href="/tasks?status=complete"
                                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-border bg-surface-2 text-[10px] font-black uppercase tracking-widest text-text-muted hover:text-white hover:border-azure/30 transition-all"
                            >
                                Historical Archive
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
