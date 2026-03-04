import { notFound } from 'next/navigation'
import { CheckCircle, Clock, XCircle, Loader2, ChevronLeft, Terminal, FolderOpen } from 'lucide-react'
import Link from 'next/link'
import { CancelButton } from './_cancel-button'

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
    projectId: string | null   // FK → sprints.id
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
    const res = await fetch(`${apiBase}/api/tasks/${id}`, { cache: 'no-store' })
    if (!res.ok) return null
    return res.json() as Promise<{ task: Task; steps: TaskStep[] }>
}

const STATUS_ICON = {
    pending: <Clock className="h-4 w-4 text-amber-400" />,
    running: <Loader2 className="h-4 w-4 text-indigo-400 animate-spin" />,
    complete: <CheckCircle className="h-4 w-4 text-emerald-400" />,
    failed: <XCircle className="h-4 w-4 text-red-400" />,
    cancelled: <XCircle className="h-4 w-4 text-zinc-500" />,
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const data = await fetchTask(id)
    if (!data) notFound()

    const { task, steps } = data
    const icon = STATUS_ICON[task.status as keyof typeof STATUS_ICON] ?? STATUS_ICON.pending
    const durationMs = task.completedAt
        ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
        : null

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link href="/tasks" className="text-zinc-500 hover:text-zinc-300 transition-colors">
                        <ChevronLeft className="h-4 w-4" />
                    </Link>
                    <div className="flex items-center gap-2 flex-wrap">
                        {icon}
                        <h1 className="text-lg font-bold text-zinc-50 font-mono">{task.id.slice(0, 8)}…</h1>
                        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] capitalize text-zinc-400">{task.type}</span>
                        <span className="rounded bg-zinc-800/50 px-2 py-0.5 text-[10px] text-zinc-500">{task.source}</span>
                        {task.projectId && (
                            <Link
                                href={`/sprints/${task.projectId}`}
                                className="flex items-center gap-1 rounded bg-indigo-900/30 border border-indigo-800/30 px-2 py-0.5 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                                <FolderOpen className="h-2.5 w-2.5" />
                                {task.project ?? task.projectId.slice(0, 8)}
                            </Link>
                        )}
                    </div>
                </div>
                {(task.status === 'pending' || task.status === 'running') && (
                    <CancelButton taskId={task.id} />
                )}
            </div>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                    { label: 'Status', value: task.status },
                    { label: 'Quality', value: task.qualityScore !== null ? `${Math.round(task.qualityScore * 100)}%` : '—' },
                    { label: 'Cost', value: task.costUsd !== null ? `$${task.costUsd.toFixed(5)}` : '—' },
                    { label: 'Duration', value: durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : 'running' },
                    { label: 'Tokens in', value: task.tokensIn?.toLocaleString() ?? '—' },
                    { label: 'Tokens out', value: task.tokensOut?.toLocaleString() ?? '—' },
                    { label: 'Created', value: new Date(task.createdAt).toLocaleTimeString() },
                    { label: 'Steps', value: String(steps.length) },
                ].map(({ label, value }) => (
                    <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</p>
                        <p className="mt-0.5 text-sm font-semibold text-zinc-200">{value}</p>
                    </div>
                ))}
            </div>

            {/* Context */}
            {Object.keys(task.context ?? {}).length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-600">Context</p>
                    <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words">
                        {JSON.stringify(task.context, null, 2)}
                    </pre>
                </div>
            )}

            {/* Outcome summary */}
            {task.outcomeSummary && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-600">Outcome</p>
                    <p className="text-sm text-zinc-300 leading-relaxed">{task.outcomeSummary}</p>
                </div>
            )}

            {/* Steps */}
            {steps.length > 0 && (
                <div>
                    <p className="mb-3 text-[10px] uppercase tracking-wide text-zinc-600">Execution steps ({steps.length})</p>
                    <div className="flex flex-col gap-3">
                        {steps.map((step) => (
                            <div key={step.id} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <Terminal className="h-3.5 w-3.5 text-zinc-600" />
                                        <span className="text-xs font-medium text-zinc-400">Step {step.stepNumber}</span>
                                        {step.toolCalls?.length > 0 && (
                                            <div className="flex gap-1">
                                                {step.toolCalls.slice(0, 5).map((tc, i) => (
                                                    <span key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-mono text-zinc-500">
                                                        {tc.tool}
                                                    </span>
                                                ))}
                                                {step.toolCalls.length > 5 && (
                                                    <span className="text-[9px] text-zinc-600">+{step.toolCalls.length - 5}</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                                        {step.tokensIn !== null && <span>{step.tokensIn?.toLocaleString()}in</span>}
                                        {step.tokensOut !== null && <span>{step.tokensOut?.toLocaleString()}out</span>}
                                        {step.durationMs !== null && <span>{step.durationMs}ms</span>}
                                        <span className={step.ok ? 'text-emerald-500' : 'text-red-500'}>{step.ok ? '✓' : '✗'}</span>
                                    </div>
                                </div>
                                {step.output && (
                                    <pre className="text-[11px] text-zinc-500 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                                        {step.output.slice(0, 800)}{step.output.length > 800 ? '…' : ''}
                                    </pre>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
