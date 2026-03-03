'use server'

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

async function fetchRecent(workspaceId: string): Promise<Task[]> {
    const apiUrl = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    try {
        const res = await fetch(
            `${apiUrl}/api/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=8`,
            { cache: 'no-store' },
        )
        if (!res.ok) return []
        const data = await res.json() as { items: Task[] }
        return data.items
    } catch {
        return []
    }
}

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

export async function TaskFeed() {
    const workspaceId = process.env.DEFAULT_WORKSPACE_ID ?? 'demo'
    const tasks = await fetchRecent(workspaceId)

    if (tasks.length === 0) {
        return (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
                <p className="text-sm text-zinc-500">No tasks yet. Send a message to get started.</p>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
            <div className="border-b border-zinc-800/50 px-4 py-3">
                <h2 className="text-[13px] font-semibold">Recent Tasks</h2>
            </div>
            <ul className="divide-y divide-zinc-800/50">
                {tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-3 px-4 py-3">
                        <span
                            className={`mt-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_COLORS[task.status] ?? STATUS_COLORS.queued}`}
                        >
                            {task.status}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] text-zinc-200">
                                {task.outcomeSummary
                                    ? task.outcomeSummary
                                    : `${task.type} task via ${task.source}`}
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
        </div>
    )
}
