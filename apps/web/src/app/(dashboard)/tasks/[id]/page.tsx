import { notFound } from 'next/navigation'
import {
    CheckCircle2,
    Clock,
    XCircle,
    Loader2,
    ChevronLeft,
    FolderOpen,
    AlertTriangle,
    Zap,
    MessageSquare,
} from 'lucide-react'
import Link from 'next/link'
import { CancelButton } from './_cancel-button'
import { BlockedActions } from './_blocked-actions'

interface TaskStep {
    id: string
    stepNumber: number
    ok: boolean
    output: string | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    durationMs: number | null
    toolCalls: Array<{ tool: string; input: unknown; output: unknown }>
}

interface Task {
    id: string
    type: string
    status: string
    source: string
    project: string | null
    projectId: string | null
    context: Record<string, unknown>
    outcomeSummary: string | null
    qualityScore: number | null
    costUsd: number | null
    tokensIn: number | null
    tokensOut: number | null
    createdAt: string
    completedAt: string | null
}

async function fetchTask(id: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    const res = await fetch(`${apiBase}/api/v1/tasks/${id}`, { cache: 'no-store' })
    if (!res.ok) return null
    return res.json() as Promise<{ task: Task; steps: TaskStep[] }>
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
    pending: { icon: <Clock className="h-4 w-4" />, label: 'Pending', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
    queued: { icon: <Clock className="h-4 w-4" />, label: 'Queued', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
    running: { icon: <Loader2 className="h-4 w-4 animate-spin" />, label: 'Running', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
    claimed: { icon: <Loader2 className="h-4 w-4 animate-spin" />, label: 'Running', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
    complete: { icon: <CheckCircle2 className="h-4 w-4" />, label: 'Complete', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
    failed: { icon: <XCircle className="h-4 w-4" />, label: 'Failed', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
    blocked: { icon: <AlertTriangle className="h-4 w-4" />, label: 'Blocked', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
    cancelled: { icon: <XCircle className="h-4 w-4" />, label: 'Cancelled', color: 'text-zinc-500', bg: 'bg-zinc-800/60 border-zinc-700/40' },
}

function humanSource(source: string, context: Record<string, unknown>): string {
    if (context?.channel === 'webchat' || source === 'dashboard') return 'Web chat'
    if (source === 'telegram') return 'Telegram'
    if (source === 'cron') return 'Scheduled'
    if (source === 'api') return 'API'
    return source
}

function humanContext(context: Record<string, unknown>): { label: string; value: string }[] {
    const skip = new Set(['channel', 'respondVia', 'sessionId'])
    return Object.entries(context)
        .filter(([k, v]) => !skip.has(k) && v != null && String(v).trim() !== '')
        .map(([k, v]) => ({
            label: k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
            value: String(v),
        }))
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const data = await fetchTask(id)
    if (!data) notFound()

    const { task, steps } = data
    const sc = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending
    const durationMs = task.completedAt
        ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
        : null
    const contextItems = humanContext(task.context ?? {})
    const message = task.context?.message as string | undefined

    return (
        <div className="flex flex-col gap-5 max-w-3xl">

            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link href="/tasks" className="text-zinc-500 hover:text-zinc-300 transition-colors">
                        <ChevronLeft className="h-4 w-4" />
                    </Link>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium ${sc.color} ${sc.bg}`}>
                            {sc.icon}
                            {sc.label}
                        </span>
                        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] capitalize text-zinc-400">{task.type}</span>
                        <span className="inline-flex items-center gap-1 rounded bg-zinc-800/50 px-2 py-0.5 text-[11px] text-zinc-500">
                            <MessageSquare className="h-3 w-3" />
                            {humanSource(task.source, task.context ?? {})}
                        </span>
                        {task.projectId && (
                            <Link
                                href={`/projects/${task.projectId}`}
                                className="inline-flex items-center gap-1 rounded border border-indigo-800/30 bg-indigo-900/20 px-2 py-0.5 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                                <FolderOpen className="h-3 w-3" />
                                {task.project ?? 'Project'}
                            </Link>
                        )}
                    </div>
                </div>
                {(task.status === 'pending' || task.status === 'running' || task.status === 'queued') && (
                    <CancelButton taskId={task.id} />
                )}
            </div>

            {/* Blocked action panel */}
            {task.status === 'blocked' && (
                <BlockedActions taskId={task.id} outcomeSummary={task.outcomeSummary} />
            )}

            {/* What was asked */}
            {message && (
                <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4">
                    <p className="mb-1.5 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Request</p>
                    <p className="text-sm text-zinc-200 leading-relaxed">{message}</p>
                </div>
            )}

            {/* Outcome — primary */}
            {task.outcomeSummary ? (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <p className="mb-1.5 text-[11px] font-medium text-emerald-600 uppercase tracking-wider">Outcome</p>
                    <p className="text-sm text-zinc-200 leading-relaxed">{task.outcomeSummary}</p>
                </div>
            ) : task.status === 'running' || task.status === 'claimed' ? (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 flex items-center gap-3">
                    <Loader2 className="h-4 w-4 text-blue-400 animate-spin shrink-0" />
                    <p className="text-sm text-zinc-400">Agent is working on this task…</p>
                </div>
            ) : null}

            {/* Stats row */}
            <div className="flex flex-wrap gap-3 text-[12px] text-zinc-500">
                {[
                    task.qualityScore != null && { label: 'Quality', value: `${Math.round(task.qualityScore * 100)}%`, color: 'text-zinc-300' },
                    task.costUsd != null && { label: 'Cost', value: `$${task.costUsd.toFixed(5)}`, color: 'text-zinc-400' },
                    durationMs != null && { label: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s`, color: 'text-zinc-400' },
                    steps.length > 0 && { label: 'Steps', value: String(steps.length), color: 'text-zinc-400' },
                    (task.tokensIn || task.tokensOut) && {
                        label: 'Tokens',
                        value: `${(task.tokensIn ?? 0).toLocaleString()} in · ${(task.tokensOut ?? 0).toLocaleString()} out`,
                        color: 'text-zinc-500',
                    },
                    { label: 'Started', value: new Date(task.createdAt).toLocaleString(), color: 'text-zinc-500' },
                ].filter(Boolean).map((item) => {
                    const { label, value, color } = item as { label: string; value: string; color: string }
                    return (
                        <span key={label} className="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/40 px-2.5 py-1">
                            <span className="text-zinc-600">{label}</span>
                            <span className={color}>{value}</span>
                        </span>
                    )
                })}
            </div>

            {/* Context — human-readable fields only */}
            {contextItems.length > 0 && (
                <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4">
                    <p className="mb-3 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Context</p>
                    <dl className="flex flex-col gap-2">
                        {contextItems.map(({ label, value }) => (
                            <div key={label} className="flex gap-3 text-sm">
                                <dt className="w-32 shrink-0 text-zinc-600">{label}</dt>
                                <dd className="text-zinc-300 break-all">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}

            {/* Execution steps — collapsed summary */}
            {steps.length > 0 && (
                <div>
                    <p className="mb-3 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                        <Zap className="h-3 w-3" />
                        Execution steps ({steps.length})
                    </p>
                    <div className="flex flex-col gap-2">
                        {steps.map((step) => (
                            <div key={step.id} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`text-[11px] font-medium ${step.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                                            Step {step.stepNumber}
                                        </span>
                                        {step.toolCalls?.map((tc, i) => (
                                            <span key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                                                {tc.tool}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-zinc-600 shrink-0 ml-2">
                                        {step.durationMs != null && <span>{step.durationMs}ms</span>}
                                        {step.tokensIn != null && <span>{step.tokensIn?.toLocaleString()}t</span>}
                                    </div>
                                </div>
                                {step.output && (
                                    <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed line-clamp-3">
                                        {step.output.slice(0, 400)}{step.output.length > 400 ? '…' : ''}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
