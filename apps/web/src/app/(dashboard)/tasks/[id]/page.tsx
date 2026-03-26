// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { notFound } from 'next/navigation'
import {
    Loader2,
    ChevronLeft,
    FolderOpen,
    Zap,
    MessageSquare,
    Users,
    FileText,
} from 'lucide-react'
import Link from 'next/link'
import { CancelButton } from './_cancel-button'
import { BlockedActions } from './_blocked-actions'
import { CopyId } from '@web/components/copy-id'
import { TaskError } from '@web/components/task-error'
import { WorksPanel } from '@web/components/works-panel'
import { StatusBadge } from '@plexo/ui'

interface TaskStep {
    id: string
    stepNumber: number
    model: string | null
    ok: boolean
    output: string | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    durationMs: number | null
    toolCalls: Array<{ tool: string; input: unknown; output: unknown }>
}

interface TaskWork {
    type: 'file' | 'diff' | 'url' | 'data' | 'command'
    label: string
    content: string
}

interface TaskDeliverable {
    summary: string
    outcome: 'completed' | 'partial' | 'blocked' | 'failed'
    works: TaskWork[]
    verificationSteps: string[]
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
    deliverable: TaskDeliverable | null
}

interface TaskAsset {
    filename: string
    bytes: number
    isText: boolean
    content: string | null
}

async function fetchTask(id: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    const res = await fetch(`${apiBase}/api/v1/tasks/${id}`, { cache: 'no-store' })
    if (!res.ok) return null
    return res.json() as Promise<{ task: Task; steps: TaskStep[] }>
}

async function fetchAssets(id: string): Promise<TaskAsset[]> {
    try {
        const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
        const res = await fetch(`${apiBase}/api/v1/tasks/${id}/assets`, { cache: 'no-store' })
        if (!res.ok) return []
        const data = await res.json() as { items: TaskAsset[] }
        return data.items ?? []
    } catch {
        return []
    }
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
    const [data, assets] = await Promise.all([fetchTask(id), fetchAssets(id)])
    if (!data) notFound()

    const { task, steps } = data
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
                    <Link href="/tasks" className="flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-[32px] md:min-w-[32px] rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-2/50 transition-colors -ml-2">
                        <ChevronLeft className="h-5 w-5 md:h-4 md:w-4" />
                    </Link>
                    <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge status={task.status} />
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] capitalize text-text-secondary">{task.type}</span>
                        <span className="inline-flex items-center gap-1 rounded bg-surface-2/50 px-2 py-0.5 text-[11px] text-text-muted">
                            <MessageSquare className="h-3 w-3" />
                            {humanSource(task.source, task.context ?? {})}
                        </span>
                        {task.projectId && (
                            <Link
                                href={`/projects/${task.projectId}`}
                                className="inline-flex items-center gap-1 rounded border border-azure-800/30 bg-azure-900/20 px-2 py-0.5 text-[11px] text-azure hover:text-azure transition-colors"
                            >
                                <FolderOpen className="h-3 w-3" />
                                {task.project ?? 'Project'}
                            </Link>
                        )}
                        <CopyId id={task.id} label="task" />
                    </div>
                </div>
                {(task.status === 'pending' || task.status === 'running' || task.status === 'queued') && (
                    <CancelButton taskId={task.id} />
                )}
            </div>

            {/* Blocked or failed action panel */}
            {(task.status === 'blocked' || task.status === 'cancelled') && (
                <BlockedActions taskId={task.id} outcomeSummary={task.outcomeSummary} status={task.status} />
            )}

            {/* What was asked */}
            {message && (
                <div className="rounded-xl border border-border/60 bg-surface-1/40 p-4">
                    <p className="mb-1.5 text-[11px] font-medium text-text-muted uppercase tracking-wider">Request</p>
                    <p className="text-sm text-text-primary leading-relaxed">{message}</p>
                </div>
            )}

            {/* Outcome — primary */}
            {task.outcomeSummary && (task.status === 'blocked' || task.status === 'failed') ? (
                <TaskError outcomeSummary={task.outcomeSummary} status={task.status} />
            ) : task.outcomeSummary ? (
                <div className="rounded-xl border border-azure/20 bg-azure/5 p-4">
                    <p className="mb-1.5 text-[11px] font-medium text-azure-600 uppercase tracking-wider">Outcome</p>
                    <p className="text-sm text-text-primary leading-relaxed">{task.outcomeSummary}</p>
                </div>
            ) : task.status === 'running' || task.status === 'claimed' ? (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 flex items-center gap-3">
                    <Loader2 className="h-4 w-4 text-blue-400 animate-spin shrink-0" />
                    <p className="text-sm text-text-secondary">Agent is working on this task…</p>
                </div>
            ) : null}

            {/* Structured deliverable */}
            {task.deliverable && <WorksPanel deliverable={task.deliverable} />}

            {/* Assets produced by write_asset */}
            {assets.length > 0 && (
                <div className="rounded-xl border border-border/60 bg-surface-1/40 p-4">
                    <p className="mb-3 text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-2">
                        <FileText className="h-3 w-3" />
                        Deliverables ({assets.length})
                    </p>
                    <div className="flex flex-col gap-2">
                        {assets.map((asset) => {
                            const sizeLabel = asset.bytes < 1024 ? `${asset.bytes}B` : asset.bytes < 1024 * 1024 ? `${(asset.bytes / 1024).toFixed(1)}KB` : `${(asset.bytes / (1024 * 1024)).toFixed(1)}MB`
                            return (
                                <details key={asset.filename} className="rounded-lg border border-zinc-700/60 bg-zinc-800/40 overflow-hidden group/a">
                                    <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-700/40 transition-colors list-none">
                                        <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                                        <span className="flex-1 text-xs font-medium text-text-primary font-mono truncate">{asset.filename}</span>
                                        <span className="text-[10px] text-text-muted shrink-0">{sizeLabel}</span>
                                        <span className="text-[10px] text-text-muted shrink-0 group-open/a:hidden">▸</span>
                                        <span className="text-[10px] text-text-muted shrink-0 hidden group-open/a:inline">▾</span>
                                    </summary>
                                    {asset.isText && asset.content && (
                                        <div className="border-t border-zinc-700/60">
                                            <pre className="text-[11px] font-mono text-text-secondary leading-relaxed p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-words">{asset.content}</pre>
                                        </div>
                                    )}
                                    {!asset.isText && (
                                        <div className="border-t border-zinc-700/60 px-3 py-2 text-[11px] text-text-muted italic">Binary file</div>
                                    )}
                                </details>
                            )
                        })}
                    </div>
                </div>
            )}


            {/* Stats row */}
            <div className="flex flex-wrap gap-3 text-[12px] text-text-muted">
                {[
                    task.qualityScore != null && { label: 'Quality', value: `${Math.round(task.qualityScore * 100)}%`, color: 'text-text-secondary' },
                    task.costUsd != null && { label: 'Cost', value: `$${task.costUsd.toFixed(5)}`, color: 'text-text-secondary' },
                    durationMs != null && { label: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s`, color: 'text-text-secondary' },
                    steps.length > 0 && { label: 'Steps', value: String(steps.length), color: 'text-text-secondary' },
                    (task.tokensIn || task.tokensOut) && {
                        label: 'Tokens',
                        value: `${(task.tokensIn ?? 0).toLocaleString()} in · ${(task.tokensOut ?? 0).toLocaleString()} out`,
                        color: 'text-text-muted',
                    },
                    { label: 'Started', value: new Date(task.createdAt).toLocaleString(), color: 'text-text-muted' },
                ].filter(Boolean).map((item) => {
                    const { label, value, color } = item as { label: string; value: string; color: string }
                    return (
                        <span key={label} className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-1/40 px-2.5 py-1">
                            <span className="text-text-muted">{label}</span>
                            <span className={color}>{value}</span>
                        </span>
                    )
                })}
            </div>

            {/* Quality judge breakdown */}
            {(() => {
                const judge = (task.context as Record<string, unknown>)?._judge as {
                    mode?: string
                    selfScore?: number
                    judgeCount?: number
                    dissenters?: string[]
                    models?: string[]
                } | undefined
                if (!judge || judge.mode === 'fallback') return null
                const selfPct = judge.selfScore != null ? Math.round(judge.selfScore * 100) : null
                const verPct = task.qualityScore != null ? Math.round(task.qualityScore * 100) : null
                const delta = selfPct != null && verPct != null ? verPct - selfPct : null
                return (
                    <div className="rounded-xl border border-azure-800/30 bg-azure/20 p-4 flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Users className="h-3.5 w-3.5 text-azure" />
                            <span className="text-[11px] font-semibold text-azure uppercase tracking-wider">
                                Quality ensemble
                            </span>
                            <span className="ml-auto text-[10px] text-azure/60 capitalize">
                                {judge.mode?.replace('+', ' + ')}
                            </span>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-text-muted">Self-assessed</span>
                                <span className="text-sm font-semibold text-text-secondary">{selfPct != null ? `${selfPct}%` : '—'}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-text-muted">Verified</span>
                                <span className="text-sm font-semibold text-azure">{verPct != null ? `${verPct}%` : '—'}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-text-muted">Delta</span>
                                <span className={`text-sm font-semibold ${delta == null ? 'text-text-muted'
                                        : delta > 0 ? 'text-azure'
                                            : delta < 0 ? 'text-rose-400'
                                                : 'text-text-secondary'
                                    }`}>
                                    {delta != null ? `${delta > 0 ? '+' : ''}${delta}pp` : '—'}
                                </span>
                            </div>
                        </div>
                        {judge.models && judge.models.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-text-muted">{judge.judgeCount} judge{judge.judgeCount !== 1 ? 's' : ''}</span>
                                <div className="flex flex-wrap gap-1">
                                    {judge.models.map((m) => (
                                        <span key={m} className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${(judge.dissenters ?? []).includes(m)
                                                ? 'bg-rose-900/30 text-rose-400'
                                                : 'bg-surface-2 text-text-secondary'
                                            }`}>{m}</span>
                                    ))}
                                </div>
                                {(judge.dissenters?.length ?? 0) > 0 && (
                                    <p className="text-[10px] text-rose-400/70">Red = dissented · cloud arbitrator called</p>
                                )}
                            </div>
                        )}
                    </div>
                )
            })()}

            {/* Context — human-readable fields only */}
            {contextItems.length > 0 && (
                <div className="rounded-xl border border-border/60 bg-surface-1/40 p-4">
                    <p className="mb-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Context</p>
                    <dl className="flex flex-col gap-2">
                        {contextItems.map(({ label, value }) => (
                            <div key={label} className="flex gap-3 text-sm">
                                <dt className="w-32 shrink-0 text-text-muted">{label}</dt>
                                <dd className="text-text-secondary break-all">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}

            {/* Execution steps — collapsed summary */}
            {steps.length > 0 && (
                <div>
                    <p className="mb-3 text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-2">
                        <Zap className="h-3 w-3" />
                        Execution steps ({steps.length})
                    </p>
                    <div className="flex flex-col gap-2">
                        {steps.map((step) => (
                            <div key={step.id} className="rounded-xl border border-border bg-surface-1/30 p-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`text-[11px] font-medium ${step.ok ? 'text-azure' : 'text-red'}`}>
                                            Step {step.stepNumber}
                                        </span>
                                        {step.model && (
                                            <span className="rounded border border-azure-800/40 bg-azure/30 px-1.5 py-0.5 text-[10px] font-mono text-azure">
                                                {step.model}
                                            </span>
                                        )}
                                        {step.toolCalls?.map((tc, i) => (
                                            <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                                                {tc.tool}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-text-muted shrink-0 ml-2">
                                        {step.durationMs != null && <span>{step.durationMs}ms</span>}
                                        {step.tokensIn != null && <span>{step.tokensIn?.toLocaleString()}t</span>}
                                    </div>
                                </div>
                                {step.output && (
                                    <p className="mt-2 text-[11px] text-text-muted leading-relaxed line-clamp-3">
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
