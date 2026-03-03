'use server'

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
    const apiUrl = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    try {
        const res = await fetch(
            `${apiUrl}/api/dashboard/summary?workspaceId=${encodeURIComponent(workspaceId)}`,
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
    const workspaceId = process.env.DEFAULT_WORKSPACE_ID ?? 'demo'
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
                ? 'from-green-500 to-emerald-600'
                : 'from-emerald-500 to-emerald-600',
            dot: data?.agent.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-zinc-600',
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
            accent: 'from-amber-500 to-orange-600',
            dot: (running + queued) > 0 ? 'bg-amber-400 animate-pulse' : 'bg-zinc-600',
            content: data
                ? Object.entries(data.tasks.byStatus)
                    .map(([s, n]) => `${n} ${s}`)
                    .join(' · ') || 'No tasks yet'
                : 'Loading…',
        },
        {
            title: 'Channels',
            subtitle: 'Telegram · API',
            icon: MessageSquare,
            accent: 'from-blue-500 to-indigo-600',
            dot: 'bg-zinc-600',
            content: data?.agent.connectedClients
                ? `${data.agent.connectedClients} live connection${data.agent.connectedClients !== 1 ? 's' : ''}`
                : 'No active connections',
        },
        {
            title: 'API Cost',
            subtitle: 'This week',
            icon: DollarSign,
            accent: pct > 80
                ? 'from-red-500 to-rose-600'
                : pct > 50
                    ? 'from-amber-500 to-orange-600'
                    : 'from-violet-500 to-purple-600',
            dot: pct > 80 ? 'bg-red-400 animate-pulse' : 'bg-zinc-600',
            content: `$${weekCost.toFixed(4)} / $${ceiling.toFixed(2)} (${Math.round(pct)}% used)`,
        },
        {
            title: 'Steps This Week',
            subtitle: 'Agent executions',
            icon: Clock,
            accent: 'from-cyan-500 to-teal-600',
            dot: 'bg-zinc-600',
            content: data
                ? `${stepsThisWeek} steps · ${(data.steps.tokensThisWeek / 1000).toFixed(1)}k tokens`
                : 'Loading…',
        },
        {
            title: 'Sprints',
            subtitle: 'None active',
            icon: GitBranch,
            accent: 'from-pink-500 to-rose-600',
            dot: 'bg-zinc-600',
            content: 'Start a sprint via Settings → Sprints.',
        },
    ]

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => {
                const Icon = card.icon
                return (
                    <div
                        key={card.title}
                        className="card-glow group rounded-xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm transition-all hover:border-zinc-700"
                    >
                        {/* Card Header */}
                        <div className="flex items-center gap-3 border-b border-zinc-800/50 p-4">
                            <div
                                className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${card.accent} text-white shadow-lg`}
                            >
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

                        {/* Card Body */}
                        <div className="px-4 py-5">
                            <p className="text-sm text-zinc-400">{card.content}</p>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
