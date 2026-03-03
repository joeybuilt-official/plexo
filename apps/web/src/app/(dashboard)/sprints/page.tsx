import Link from 'next/link'

interface Sprint {
    id: string
    repo: string
    request: string
    status: string
    totalTasks: number
    completedTasks: number
    failedTasks: number
    conflictCount: number
    costUsd: number | null
    createdAt: string
    completedAt: string | null
}

const STATUS_DOT: Record<string, string> = {
    planning: 'bg-purple-500',
    running: 'bg-blue-500 animate-pulse',
    finalizing: 'bg-blue-400 animate-pulse',
    complete: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-zinc-600',
}

const STATUS_TEXT: Record<string, string> = {
    planning: 'text-purple-400',
    running: 'text-blue-400',
    finalizing: 'text-blue-400',
    complete: 'text-emerald-400',
    failed: 'text-red-400',
    cancelled: 'text-zinc-500',
}

async function fetchSprints(): Promise<Sprint[]> {
    const apiBase = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
    // For dev without auth-linked workspaceId, use a placeholder
    const workspaceId = process.env.DEV_WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000000'
    try {
        const res = await fetch(`${apiBase}/api/sprints?workspaceId=${workspaceId}&limit=50`, {
            cache: 'no-store',
        })
        if (!res.ok) return []
        const data = await res.json() as { items: Sprint[] }
        return data.items
    } catch {
        return []
    }
}

function SprintCard({ sprint }: { sprint: Sprint }) {
    const pct = sprint.totalTasks > 0
        ? Math.round((sprint.completedTasks / sprint.totalTasks) * 100)
        : 0

    return (
        <Link
            href={`/sprints/${sprint.id}`}
            className="group block rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-all hover:border-indigo-500/40 hover:bg-zinc-900"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[sprint.status] ?? 'bg-zinc-600'}`} />
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">
                            {sprint.request.length > 80 ? sprint.request.slice(0, 80) + '…' : sprint.request}
                        </p>
                        <p className="mt-0.5 text-xs font-mono text-zinc-500">{sprint.repo}</p>
                    </div>
                </div>
                <span className={`shrink-0 text-xs font-medium ${STATUS_TEXT[sprint.status] ?? 'text-zinc-400'}`}>
                    {sprint.status}
                </span>
            </div>

            {sprint.totalTasks > 0 && (
                <div className="mt-3">
                    <div className="h-1 rounded-full bg-zinc-800">
                        <div
                            className="h-1 rounded-full bg-emerald-500 transition-all"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-600">
                        <span>{sprint.completedTasks}/{sprint.totalTasks} steps</span>
                        {sprint.failedTasks > 0 && <span className="text-red-500">{sprint.failedTasks} failed</span>}
                        {sprint.conflictCount > 0 && <span className="text-amber-500">{sprint.conflictCount} conflicts</span>}
                        {sprint.costUsd != null && <span className="ml-auto">${sprint.costUsd.toFixed(4)}</span>}
                    </div>
                </div>
            )}
        </Link>
    )
}

export default async function SprintsPage() {
    const sprints = await fetchSprints()

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Projects</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Run multiple AI tasks in parallel toward a shared goal
                    </p>
                </div>
                <Link
                    href="/sprints/new"
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    New Project
                </Link>
            </div>

            {/* Sprint list */}
            {sprints.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <div className="mb-3 text-3xl">⚡</div>
                    <p className="text-sm font-medium text-zinc-400">No projects yet</p>
                    <p className="mt-1 text-xs text-zinc-600">
                        Create a project to run parallel AI tasks across your codebase.
                    </p>
                    <Link
                        href="/sprints/new"
                        className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                    >
                        Create first project
                    </Link>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {sprints.map((sprint) => (
                        <SprintCard key={sprint.id} sprint={sprint} />
                    ))}
                </div>
            )}
        </div>
    )
}
