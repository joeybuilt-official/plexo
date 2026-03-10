// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use server'

import { getWorkspaceId } from '@web/lib/workspace'

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
            `${apiUrl}/api/v1/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=8`,
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
    complete: 'bg-azure/20 text-azure border-azure/30',
    running: 'bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse',
    queued: 'bg-amber/20 text-amber border-amber-500/30',
    blocked: 'bg-red/20 text-red border-red-500/30',
    cancelled: 'bg-zinc-500/20 text-text-secondary border-zinc-500/30',
    claimed: 'bg-azure-dim text-azure border-azure/30',
}

function timeAgo(iso: string): string {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
}

export async function TaskFeed() {
    const workspaceId = (await getWorkspaceId()) ?? ''
    const tasks = await fetchRecent(workspaceId)

    if (tasks.length === 0) {
        return (
            <div className="rounded-xl border border-border bg-surface-1/50 p-6 text-center">
                <p className="text-sm text-text-muted">No tasks yet. Send a message to get started.</p>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-border bg-surface-1/50 backdrop-blur-sm">
            <div className="border-b border-border-subtle px-4 py-3">
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
                            <p className="truncate text-[13px] text-text-primary">
                                {task.outcomeSummary
                                    ? task.outcomeSummary
                                    : `${task.type} task via ${task.source}`}
                            </p>
                            <div className="mt-0.5 flex gap-2 text-[11px] text-text-muted">
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
