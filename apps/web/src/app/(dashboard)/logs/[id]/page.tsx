import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { CopyButton } from './copy-button'

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
    context: Record<string, unknown>
    qualityScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    outcomeSummary: string | null
    createdAt: string | null
    claimedAt: string | null
    completedAt: string | null
}

const STATUS_STYLES: Record<string, string> = {
    complete: 'bg-emerald-950 text-emerald-400 border-emerald-800',
    running: 'bg-blue-950 text-blue-400 border-blue-800',
    queued: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    blocked: 'bg-amber-950 text-amber-400 border-amber-800',
    failed: 'bg-red-950 text-red-400 border-red-800',
}

function fmt(iso: string | null | undefined): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function elapsed(start: string | null, end: string | null): string {
    if (!start || !end) return '—'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (isNaN(ms) || ms < 0) return '—'
    return ms < 60_000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 60_000).toFixed(2)}m`
}

async function fetchTask(id: string): Promise<{ task: TaskDetail; steps: TaskStep[] } | null> {
    const INTERNAL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    try {
        const res = await fetch(`${INTERNAL}/api/v1/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) return null
        const data = await res.json() as { task?: TaskDetail; steps?: TaskStep[] }
        if (!data.task) return null
        return { task: data.task, steps: data.steps ?? [] }
    } catch { return null }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LogDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const result = await fetchTask(id)

    if (!result) {
        return (
            <div className="flex flex-col gap-4 max-w-4xl">
                <Link href="/logs" className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-fit">
                    <ArrowLeft size={12} /> Back to logs
                </Link>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
                    <p className="text-sm text-zinc-400 font-medium mb-1">Task not found</p>
                    <p className="text-xs text-zinc-600 font-mono">{id}</p>
                </div>
            </div>
        )
    }

    const { task, steps } = result
    const context = (task.context ?? {}) as Record<string, unknown>
    const description = (context.description ?? context.prompt ?? context.message ?? '') as string
    const contextRest = Object.fromEntries(
        Object.entries(context).filter(([k]) => !['description', 'prompt', 'message'].includes(k))
    )

    const exportText = [
        `Task: ${task.id}`,
        `Status: ${task.status}  Type: ${task.type}  Source: ${task.source}`,
        `Created: ${fmt(task.createdAt)}`,
        `Completed: ${fmt(task.completedAt)}`,
        `Duration: ${elapsed(task.claimedAt ?? task.createdAt, task.completedAt)}`,
        task.tokensIn != null ? `Tokens: ${task.tokensIn + (task.tokensOut ?? 0)}` : '',
        task.costUsd != null ? `Cost: $${task.costUsd.toFixed(5)}` : '',
        task.qualityScore != null ? `Quality: ${Math.round(task.qualityScore * 100)}%` : '',
        description ? `\nDescription:\n${description}` : '',
        task.outcomeSummary ? `\nOutcome:\n${task.outcomeSummary}` : '',
        Object.keys(contextRest).length > 0 ? `\nContext:\n${JSON.stringify(contextRest, null, 2)}` : '',
        steps.length > 0
            ? `\nSteps (${steps.length}):\n${steps.map(s =>
                `  [${s.stepNumber}] ${s.model ?? ''} ${s.tokensIn != null ? `${s.tokensIn + (s.tokensOut ?? 0)}tok` : ''}\n  ${s.outcome ?? ''}`
            ).join('\n')}`
            : '',
    ].filter(Boolean).join('\n')

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            {/* Back + copy */}
            <div className="flex items-center justify-between">
                <Link href="/logs" className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                    <ArrowLeft size={12} /> Back to logs
                </Link>
                <CopyButton text={exportText} label="Copy log" />
            </div>

            {/* Header */}
            <div>
                <div className="flex items-center gap-3 mb-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[task.status] ?? 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                        {task.status}
                    </span>
                    <span className="font-mono text-xs text-zinc-500">{task.id}</span>
                </div>
                <p className="text-lg font-semibold text-zinc-100 leading-snug">
                    {description?.slice(0, 200) || `${task.type} task`}
                </p>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {([
                    ['Source', task.source, false],
                    ['Type', task.type, false],
                    ['Duration', elapsed(task.claimedAt ?? task.createdAt, task.completedAt), true],
                    ['Tokens', task.tokensIn != null ? (task.tokensIn + (task.tokensOut ?? 0)).toLocaleString() : '—', true],
                    ['Cost', task.costUsd != null ? `$${task.costUsd.toFixed(5)}` : '—', true],
                    ['Quality', task.qualityScore != null ? `${Math.round(task.qualityScore * 100)}%` : '—', true],
                    ['Created', fmt(task.createdAt), false],
                    ['Completed', fmt(task.completedAt), false],
                ] as [string, string, boolean][]).map(([label, value, mono]) => (
                    <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                        <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">{label}</p>
                        <p className={`text-sm text-zinc-300 truncate capitalize ${mono ? 'font-mono' : ''}`}>{value}</p>
                    </div>
                ))}
            </div>

            {/* Outcome / blocked notice */}
            {task.outcomeSummary ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">Outcome</p>
                    <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{task.outcomeSummary}</p>
                </div>
            ) : ['blocked', 'failed', 'cancelled'].includes(task.status) ? (
                <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-4">
                    <p className="text-[10px] text-amber-700 uppercase tracking-wider mb-2">
                        {task.status === 'blocked' ? 'Blocked — no execution' : task.status === 'failed' ? 'Failed' : 'Cancelled'}
                    </p>
                    <p className="text-sm text-amber-400/70 leading-relaxed">
                        {task.status === 'blocked'
                            ? 'Agent claimed this task but could not execute — likely no AI provider credential was configured at the time.'
                            : 'No outcome was recorded.'}
                    </p>
                </div>
            ) : null}

            {/* Context */}
            {(description || Object.keys(contextRest).length > 0) && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">Context</p>
                    {description && (
                        <div className="mb-4">
                            <p className="text-xs text-zinc-500 mb-1">Request</p>
                            <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">{description}</p>
                        </div>
                    )}
                    {Object.keys(contextRest).length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {Object.entries(contextRest).map(([k, v]) => (
                                <div key={k} className="rounded bg-zinc-950 px-2.5 py-2">
                                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">{k}</p>
                                    <p className="text-xs text-zinc-400 font-mono truncate">{String(v)}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Steps */}
            {steps.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">Execution steps ({steps.length})</p>
                    <ol className="flex flex-col gap-3">
                        {steps.map((step) => {
                            const toolCalls = Array.isArray(step.toolCalls)
                                ? (step.toolCalls as Array<{ name?: string }>)
                                : []
                            return (
                                <li key={step.id} className="flex gap-3">
                                    <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-[10px] font-mono text-zinc-400">
                                        {step.stepNumber}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                                            {step.model && <span className="text-[10px] font-mono text-zinc-600">{step.model}</span>}
                                            {step.tokensIn != null && (
                                                <span className="text-[10px] text-zinc-700">
                                                    {(step.tokensIn + (step.tokensOut ?? 0)).toLocaleString()} tok
                                                </span>
                                            )}
                                            {toolCalls.map((t, i) => t.name
                                                ? <span key={i} className="text-[10px] text-violet-600 bg-violet-950/40 rounded px-1">{t.name}</span>
                                                : null
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
