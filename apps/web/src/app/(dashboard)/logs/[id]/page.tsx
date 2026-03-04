import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

const INTERNAL_API = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
const WS_ID = process.env.DEV_WORKSPACE_ID ?? ''

interface TaskStep {
    id: string
    stepNumber: number
    model: string | null
    tokensIn: number | null
    tokensOut: number | null
    toolCalls: unknown
    outcome: string | null
    createdAt: string
}

interface TaskDetail {
    id: string
    type: string
    status: string
    source: string
    project: string | null
    context: Record<string, unknown>
    qualityScore: number | null
    confidenceScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    outcomeSummary: string | null
    createdAt: string
    claimedAt: string | null
    completedAt: string | null
    steps: TaskStep[]
}

const STATUS_STYLES: Record<string, string> = {
    complete: 'bg-emerald-950 text-emerald-400 border-emerald-800',
    running: 'bg-blue-950 text-blue-400 border-blue-800',
    queued: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    blocked: 'bg-amber-950 text-amber-400 border-amber-800',
    failed: 'bg-red-950 text-red-400 border-red-800',
}

async function fetchTask(id: string): Promise<TaskDetail | null> {
    if (!WS_ID) return null
    try {
        const res = await fetch(`${INTERNAL_API}/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) return null
        const data = await res.json() as { task: TaskDetail; steps: TaskStep[] }
        return { ...data.task, steps: data.steps ?? [] }
    } catch {
        return null
    }
}

function fmt(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
}

function elapsed(start: string | null, end: string | null): string {
    if (!start || !end) return '—'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (isNaN(ms) || ms < 0) return '—'
    return ms < 60_000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 60_000).toFixed(2)}m`
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LogDetailPage({ params }: { params: { id: string } }) {
    const task = await fetchTask(params.id)
    if (!task) notFound()

    const description = (task.context?.description ?? task.context?.prompt ?? task.context?.message ?? '') as string
    const contextRest = Object.fromEntries(
        Object.entries(task.context).filter(([k]) => !['description', 'prompt', 'message'].includes(k))
    )

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            {/* Back */}
            <Link href="/logs" className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-fit">
                <ArrowLeft size={12} /> Back to logs
            </Link>

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[task.status] ?? 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                            {task.status}
                        </span>
                        <span className="font-mono text-xs text-zinc-500">{task.id}</span>
                    </div>
                    <p className="text-lg font-semibold text-zinc-100 leading-snug">
                        {description?.slice(0, 200) || `${task.type} task`}
                    </p>
                </div>
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                    { label: 'Source', value: task.source, mono: false },
                    { label: 'Type', value: task.type, mono: false },
                    { label: 'Duration', value: elapsed(task.claimedAt ?? task.createdAt, task.completedAt), mono: true },
                    { label: 'Tokens', value: task.tokensIn != null ? `${(task.tokensIn + (task.tokensOut ?? 0)).toLocaleString()}` : '—', mono: true },
                    { label: 'Cost', value: task.costUsd != null ? `$${task.costUsd.toFixed(5)}` : '—', mono: true },
                    { label: 'Quality', value: task.qualityScore != null ? `${Math.round(task.qualityScore * 100)}%` : '—', mono: true },
                    { label: 'Created', value: fmt(task.createdAt), mono: false },
                    { label: 'Completed', value: fmt(task.completedAt), mono: false },
                ].map(({ label, value, mono }) => (
                    <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                        <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">{label}</p>
                        <p className={`text-sm text-zinc-300 truncate capitalize ${mono ? 'font-mono' : ''}`}>{value}</p>
                    </div>
                ))}
            </div>

            {/* Outcome summary */}
            {task.outcomeSummary && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">Outcome</p>
                    <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{task.outcomeSummary}</p>
                </div>
            )}

            {/* Context */}
            {(description || Object.keys(contextRest).length > 0) && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">Context</p>
                    {description && (
                        <div className="mb-3">
                            <p className="text-xs text-zinc-500 mb-1">Description</p>
                            <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{description}</p>
                        </div>
                    )}
                    {Object.keys(contextRest).length > 0 && (
                        <pre className="text-xs text-zinc-500 bg-zinc-950 rounded p-3 overflow-auto">
                            {JSON.stringify(contextRest, null, 2)}
                        </pre>
                    )}
                </div>
            )}

            {/* Steps */}
            {task.steps.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">
                        Execution steps ({task.steps.length})
                    </p>
                    <ol className="flex flex-col gap-3">
                        {task.steps.map((step) => {
                            const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls as Array<{ name?: string }> : []
                            return (
                                <li key={step.id} className="flex gap-3">
                                    <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-[10px] font-mono text-zinc-400">
                                        {step.stepNumber}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            {step.model && <span className="text-[10px] font-mono text-zinc-600">{step.model}</span>}
                                            {step.tokensIn != null && (
                                                <span className="text-[10px] text-zinc-700">
                                                    {(step.tokensIn + (step.tokensOut ?? 0)).toLocaleString()} tok
                                                </span>
                                            )}
                                            {toolCalls.length > 0 && (
                                                <span className="text-[10px] text-violet-600">
                                                    {toolCalls.map((t) => t.name).filter(Boolean).join(', ')}
                                                </span>
                                            )}
                                        </div>
                                        {step.outcome && (
                                            <p className="text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed">{step.outcome}</p>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                    </ol>
                </div>
            )}
        </div>
    )
}
