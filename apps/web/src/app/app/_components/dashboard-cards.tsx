// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use server'

import { getWorkspaceId } from '@web/lib/workspace'
import { apiFetch } from '@web/lib/api-server'
import {
    Activity,
    Zap,
    MessageSquare,
    DollarSign,
    Clock,
    GitBranch,
} from 'lucide-react'

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

async function fetchSummary(workspaceId: string): Promise<DashboardSummary | null> {
    try {
        const res = await apiFetch(
            `/api/v1/dashboard/summary?workspaceId=${encodeURIComponent(workspaceId)}`,
            { cache: 'no-store' },
        )
        if (!res.ok) return null
        return res.json() as Promise<DashboardSummary>
    } catch {
        return null
    }
}

export async function DashboardCards() {
    // Phase 3: workspace ID from session. For now use env default.
    const workspaceId = (await getWorkspaceId()) ?? 'demo'
    const data = await fetchSummary(workspaceId)

    const running = data?.agent.activeTasks ?? 0
    const queued = data?.agent.queuedTasks ?? 0
    const weekCost = data?.cost.thisWeek ?? 0
    const ceiling = data?.cost.ceiling ?? 10
    const pct = data?.cost.percentUsed ?? 0
    const totalTasks = data?.tasks.total ?? 0
    const stepsThisWeek = data?.steps.thisWeek ?? 0

    const cards = [
        {
            title: 'Agent Status',
            subtitle: data?.agent.status === 'running' ? 'Running' : 'Idle',
            icon: Activity,
            accent: data?.agent.status === 'running'
                ? 'bg-azure'
                : 'bg-azure',
            dot: data?.agent.status === 'running' ? 'bg-azure animate-pulse' : 'bg-surface-3',
            content: running > 0
                ? `${running} task${running !== 1 ? 's' : ''} running · ${queued} queued`
                : queued > 0
                    ? `${queued} task${queued !== 1 ? 's' : ''} queued — agent picking up`
                    : 'Idle — waiting for tasks',
        },
        {
            title: 'Tasks',
            subtitle: `${totalTasks} total`,
            icon: Zap,
            accent: 'bg-amber',
            dot: (running + queued) > 0 ? 'bg-amber animate-pulse' : 'bg-surface-3',
            content: data
                ? Object.entries(data.tasks.byStatus)
                    .map(([s, n]) => `${n} ${s}`)
                    .join(' · ') || 'No tasks yet'
                : 'Unavailable',
        },
        {
            title: 'Channels',
            subtitle: 'Telegram · API',
            icon: MessageSquare,
            accent: 'bg-azure',
            dot: 'bg-surface-3',
            content: data?.agent.connectedClients
                ? `${data.agent.connectedClients} live integration${data.agent.connectedClients !== 1 ? 's' : ''}`
                : 'No active integrations',
        },
        {
            title: 'API Cost',
            subtitle: 'This week',
            icon: DollarSign,
            accent: pct > 80
                ? 'bg-red'
                : pct > 50
                    ? 'bg-amber'
                    : 'bg-azure',
            dot: pct > 80 ? 'bg-red animate-pulse' : 'bg-surface-3',
            content: `$${weekCost.toFixed(4)} / $${ceiling.toFixed(2)} (${Math.round(pct)}% used)`,
        },
        {
            title: 'Steps This Week',
            subtitle: 'Agent executions',
            icon: Clock,
            accent: 'bg-surface-3',
            dot: 'bg-surface-3',
            content: data
                ? `${stepsThisWeek} steps · ${(data.steps.tokensThisWeek / 1000).toFixed(1)}k tokens`
                : 'Unavailable',
        },
        {
            title: 'Projects',
            subtitle: 'None active',
            icon: GitBranch,
            accent: 'bg-surface-3',
            dot: 'bg-surface-3',
            content: 'No active projects. Create one from the Projects page.',
        },
    ]

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => {
                const Icon = card.icon
                return (
                    <div
                        key={card.title}
                        id={`dashboard-card-${card.title.toLowerCase().replace(/\s+/g, '-')}`}
                        className="card-glow group rounded-sm border border-border bg-surface-1/50 transition-all hover:border-border"
                    >
                        {/* Card Header */}
                        <div className="flex items-center gap-3 border-b border-border-subtle p-4">
                            <div
                                className={`flex h-8 w-8 items-center justify-center rounded-sm  ${card.accent} text-text-primary`}
                            >
                                <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h3 className="text-[13px] font-medium">{card.title}</h3>
                                <div className="flex items-center gap-1.5">
                                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${card.dot}`} />
                                    <p className="text-[11px] text-text-muted">{card.subtitle}</p>
                                </div>
                            </div>
                        </div>

                        {/* Card Body */}
                        <div className="px-4 py-5">
                            <p className="text-sm text-text-secondary">{card.content}</p>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
