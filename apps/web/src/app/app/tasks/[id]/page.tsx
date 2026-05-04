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
    GitBranch,
} from 'lucide-react'
import Link from 'next/link'
import { CancelButton } from './_cancel-button'
import { ApprovalActions } from './_approval-actions'
import { BlockedActions } from './_blocked-actions'
import { StepRow } from './_step-row'
import { RawStepsPanel } from './_raw-steps-panel'
import { LifecycleTimeline, type LifecycleEvent } from './_lifecycle-timeline'
import { VerifySection } from './_verify-section'
import { InlineApproval, type InlineApprovalRecord } from './_inline-approval'
import { CopyId } from '@web/components/copy-id'
import { TaskError } from '@web/components/task-error'
import { WorksPanel } from '@web/components/works-panel'
import { StatusBadge } from '@plexo/ui'
import { PlexoAwarenessBadge } from '@web/components/plexo-awareness-badge'
import { AdvancedSection } from './_advanced-section'
import { TaskWorkList } from './_task-work-list'
import { PlanCard, type PlanProposalPlan } from '@web/app/app/chat/_components/plan-card'
import { apiFetch } from '@web/lib/api-server'
import type { TaskAsset } from '@web/app/app/chat/_components/types'

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
    workspaceId: string
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
    plan: PlanProposalPlan | null
}

interface TaskDetailResponse {
    task: Task
    steps: TaskStep[]
    events: LifecycleEvent[]
    approval: InlineApprovalRecord | null
}

async function fetchTask(id: string): Promise<TaskDetailResponse | null> {
    const res = await apiFetch(`/api/v1/tasks/${id}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json() as Partial<TaskDetailResponse> & { task: Task; steps: TaskStep[] }
    return {
        task: data.task,
        steps: data.steps ?? [],
        events: data.events ?? [],
        approval: data.approval ?? null,
    }
}

interface ChildTask {
    id: string
    type: string
    status: string
    source: string
    outcomeSummary: string | null
    context: Record<string, unknown>
    createdAt: string
}

async function fetchChildren(parentId: string, workspaceId: string): Promise<ChildTask[]> {
    try {
        const res = await apiFetch(`/api/v1/tasks?workspaceId=${workspaceId}&parentId=${parentId}`, { cache: 'no-store' })
        if (!res.ok) return []
        const data = await res.json() as { items: ChildTask[] }
        return data.items ?? []
    } catch {
        return []
    }
}

async function fetchAssets(id: string): Promise<TaskAsset[]> {
    try {
        const res = await apiFetch(`/api/v1/tasks/${id}/assets`, { cache: 'no-store' })
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

    const { task, steps, events, approval } = data
    const children = await fetchChildren(id, task.workspaceId)
    const durationMs = task.completedAt
        ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
        : null
    const contextItems = humanContext(task.context ?? {})
    // Strip SCL Golden Record + workspace memory preludes from historical
    // task rows so they render cleanly. Going forward chat.ts no longer
    // bakes these into the row, but the strip keeps old rows tidy without
    // a data migration.
    const rawMessage = task.context?.message as string | undefined
    const message = rawMessage
        ?.replace(/=== YOUR LEARNED KNOWLEDGE \(SCL Golden Record\) ===[\s\S]*?=== END LEARNED KNOWLEDGE ===/g, '')
        .replace(/=== WORKSPACE MEMORY \(SCL Golden Record[\s\S]*?=== END WORKSPACE MEMORY ===/g, '')
        .trim()

    return (
        <div className="flex flex-col gap-5 max-w-3xl">

            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link href="/app/tasks" aria-label="Back to tasks" className="flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-[32px] md:min-w-[32px] rounded-sm text-text-muted hover:text-text-secondary hover:bg-surface-2/50 transition-colors -ml-2">
                        <ChevronLeft className="h-5 w-5 md:h-4 md:w-4" />
                    </Link>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span data-testid="task-status"><StatusBadge status={task.status} /></span>
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] capitalize text-text-secondary">{task.type}</span>
                        <span className="inline-flex items-center gap-1 rounded bg-surface-2/50 px-2 py-0.5 text-[11px] text-text-muted">
                            <MessageSquare className="h-3 w-3" />
                            {humanSource(task.source, task.context ?? {})}
                        </span>
                        {task.projectId && (
                            <Link
                                href={`/app/projects/${task.projectId}`}
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

            {/* Awaiting-approval action panel — Phase 5 task UI surface */}
            {task.status === 'awaiting_approval' && (() => {
                const ctx = (task.context ?? {}) as Record<string, unknown>
                const approvalId = typeof ctx._approvalId === 'string' ? ctx._approvalId : null
                const code = approvalId ? approvalId.slice(0, 6) : null
                return (
                    <ApprovalActions
                        taskId={task.id}
                        confirmationCode={code}
                        description={task.outcomeSummary}
                    />
                )
            })()}

            {/* What was asked */}
            {message && (
                <section role="region" aria-labelledby="request-heading" className="rounded-sm border border-border/60 bg-surface-1/40 p-4">
                    <h2 id="request-heading" className="mb-1.5 text-[11px] font-medium text-text-muted uppercase tracking-wider">Request</h2>
                    <p className="text-sm text-text-primary leading-relaxed">{message}</p>
                </section>
            )}

            {/* Inline approval surface — when an OWD is pending and the user lands here mid-flight */}
            {approval && approval.id && (
                <InlineApproval approval={approval} />
            )}

            {/* Plan — read-only rendering of the persisted ExecutionPlan */}
            {task.plan && Array.isArray(task.plan.steps) && task.plan.steps.length > 0 && (
                <PlanCard
                    taskId={task.id}
                    plan={task.plan}
                    requiresApproval={false}
                    approvalId={null}
                    mode="detail-readonly"
                />
            )}

            {/* Unified error + resolution actions for blocked/failed/cancelled */}
            {(task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled') ? (
                <div className={`rounded-sm border overflow-hidden ${
                    task.status === 'failed' || task.status === 'blocked' ? 'border-red-900/40 bg-red-dim' : 'border-amber-900/40 bg-amber-dim'
                }`}>
                    {task.outcomeSummary && (
                        <div className="[&>div]:border-0 [&>div]:rounded-none [&>div]:bg-transparent">
                            <TaskError outcomeSummary={task.outcomeSummary} status={task.status} />
                        </div>
                    )}
                    {(task.status === 'blocked' || task.status === 'cancelled' || task.status === 'failed') && (
                        <div className={task.outcomeSummary ? 'border-t border-red-900/30' : ''}>
                            <BlockedActions taskId={task.id} outcomeSummary={task.outcomeSummary} status={task.status} embedded />
                        </div>
                    )}
                </div>
            ) : task.outcomeSummary ? (
                <div className="rounded-sm border border-azure/20 bg-azure/5 p-4">
                    <p className="mb-1.5 text-[11px] font-medium text-azure-600 uppercase tracking-wider">Outcome</p>
                    <p className="text-sm text-text-primary leading-relaxed">{task.outcomeSummary}</p>
                </div>
            ) : task.status === 'running' || task.status === 'claimed' ? (
                <div
                    className="rounded-sm border border-azure/20 bg-azure/5 p-4 flex items-center gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <Loader2 className="h-4 w-4 text-azure animate-spin shrink-0" aria-hidden="true" />
                    <p className="text-sm text-text-secondary">Agent is working on this task…</p>
                </div>
            ) : null}

            {/* Structured deliverable */}
            {task.deliverable && (
                <div data-testid="work-output">
                    <WorksPanel deliverable={task.deliverable} />
                </div>
            )}

            {/*
              Verify / Provenance — load-bearing addition for Phase F2.
              Surface verify metadata when present, OR render the placeholder so
              the absence of verification is visible (silent-hallucination
              failure mode made loud). Only render when there's a deliverable to
              verify against — running/blocked tasks have no answer to check.
            */}
            {task.deliverable && (
                <VerifySection deliverable={task.deliverable} />
            )}

            {/* Plexo awareness badge — visible on completed tasks */}
            {(task.status === 'complete' || task.status === 'completed') && (
                <div className="flex justify-end">
                    <PlexoAwarenessBadge
                        action={`Plexo ran ${steps.length} step${steps.length !== 1 ? 's' : ''}`}
                    />
                </div>
            )}

            {/* Assets produced by write_asset */}
            {assets.length > 0 && (
                <div className="rounded-sm border border-border/60 bg-surface-1/40 p-4">
                    <p className="mb-3 text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-2">
                        <FileText className="h-3 w-3" />
                        Work ({assets.length})
                    </p>
                    <TaskWorkList assets={assets} />
                </div>
            )}


            {/* Sub-task tree — A2A delegated children */}
            {children.length > 0 && (
                <details open className="rounded-sm border border-border/60 bg-surface-1/40 p-4" data-testid="subtask-tree">
                    <summary className="flex items-center gap-2 cursor-pointer list-none">
                        <GitBranch className="h-3 w-3 text-text-muted" />
                        <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Sub-tasks ({children.length})</p>
                    </summary>
                    <div className="mt-3 flex flex-col gap-2">
                        {children.map((child) => (
                            <Link
                                key={child.id}
                                href={`/app/tasks/${child.id}`}
                                className="flex items-center justify-between gap-3 rounded-sm border border-border/40 bg-surface-0/60 px-3 py-2 hover:bg-surface-2/50 transition-colors"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-xs text-text-secondary truncate">
                                        {(child.context?.description as string | undefined)?.slice(0, 80) ?? child.id}
                                    </span>
                                    {Boolean((child.context as Record<string, unknown>)?.a2a) && (
                                        <span className="shrink-0 rounded bg-azure/10 px-1.5 py-0.5 text-[10px] text-azure">A2A</span>
                                    )}
                                </div>
                                <StatusBadge status={child.status} />
                            </Link>
                        ))}
                    </div>
                </details>
            )}

            {/* Lifecycle Timeline — chronological event stream from plexo_ops_task_events */}
            <LifecycleTimeline events={events} />

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

            {/* Quality judge breakdown (Advanced only) */}
            <AdvancedSection>
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
                    <div className="rounded-sm border border-azure-800/30 bg-azure/20 p-4 flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Users className="h-3.5 w-3.5 text-azure" />
                            <span className="text-[11px] font-medium text-azure uppercase tracking-wider">
                                Quality ensemble
                            </span>
                            <span className="ml-auto text-[11px] text-azure/60 capitalize">
                                {judge.mode?.replace('+', ' + ')}
                            </span>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[11px] text-text-muted">Self-assessed</span>
                                <span className="text-sm font-medium text-text-secondary">{selfPct != null ? `${selfPct}%` : '—'}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[11px] text-text-muted">Verified</span>
                                <span className="text-sm font-medium text-azure">{verPct != null ? `${verPct}%` : '—'}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[11px] text-text-muted">Delta</span>
                                <span className={`text-sm font-medium ${delta == null ? 'text-text-muted'
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
                                <span className="text-[11px] text-text-muted">{judge.judgeCount} judge{judge.judgeCount !== 1 ? 's' : ''}</span>
                                <div className="flex flex-wrap gap-1">
                                    {judge.models.map((m) => (
                                        <span key={m} className={`rounded px-1.5 py-0.5 text-[11px] font-mono ${(judge.dissenters ?? []).includes(m)
                                                ? 'bg-rose-900/30 text-rose-400'
                                                : 'bg-surface-2 text-text-secondary'
                                            }`}>{m}</span>
                                    ))}
                                </div>
                                {(judge.dissenters?.length ?? 0) > 0 && (
                                    <p className="text-[11px] text-rose-400/70">Red = dissented · cloud arbitrator called</p>
                                )}
                            </div>
                        )}
                        {/* Rubric dimensions evaluated */}
                        {(() => {
                            const rubrics: Record<string, Array<{ dimension: string; weight: number }>> = {
                                coding: [{ dimension: 'build_passes', weight: 0.30 }, { dimension: 'tests_pass', weight: 0.25 }, { dimension: 'acceptance_met', weight: 0.25 }, { dimension: 'no_scope_creep', weight: 0.10 }, { dimension: 'no_todos_left', weight: 0.10 }],
                                deployment: [{ dimension: 'health_check_passes', weight: 0.40 }, { dimension: 'rollback_confirmed', weight: 0.30 }, { dimension: 'no_regression', weight: 0.30 }],
                                research: [{ dimension: 'sources_cited', weight: 0.25 }, { dimension: 'claims_verifiable', weight: 0.25 }, { dimension: 'actionable_output', weight: 0.30 }, { dimension: 'scope_respected', weight: 0.20 }],
                                ops: [{ dimension: 'operation_succeeded', weight: 0.40 }, { dimension: 'state_confirmed', weight: 0.40 }, { dimension: 'side_effects_logged', weight: 0.20 }],
                                writing: [{ dimension: 'grammatically_correct', weight: 0.20 }, { dimension: 'tone_appropriate', weight: 0.30 }, { dimension: 'brief_followed', weight: 0.30 }, { dimension: 'originality', weight: 0.20 }],
                                general: [{ dimension: 'goal_met', weight: 0.60 }, { dimension: 'conciseness', weight: 0.20 }, { dimension: 'helpful_tone', weight: 0.20 }],
                                marketing: [{ dimension: 'brand_alignment', weight: 0.30 }, { dimension: 'cta_clarity', weight: 0.30 }, { dimension: 'channel_optimization', weight: 0.20 }, { dimension: 'strategic_intent', weight: 0.20 }],
                                data: [{ dimension: 'accuracy', weight: 0.40 }, { dimension: 'completeness', weight: 0.30 }, { dimension: 'insightfulness', weight: 0.30 }],
                            }
                            const dims = rubrics[task.type] ?? rubrics.general
                            return (
                                <details className="group/rubric">
                                    <summary className="text-[11px] text-azure/50 cursor-pointer hover:text-azure/70 list-none flex items-center gap-1">
                                        <span className="group-open/rubric:hidden">▸ Rubric dimensions ({dims.length})</span>
                                        <span className="hidden group-open/rubric:inline">▾ Rubric dimensions ({dims.length})</span>
                                    </summary>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {dims.map((d) => (
                                            <span key={d.dimension} className="rounded bg-surface-2/60 px-2 py-0.5 text-[11px] text-text-secondary font-mono">
                                                {d.dimension.replace(/_/g, ' ')} <span className="text-text-muted">{Math.round(d.weight * 100)}%</span>
                                            </span>
                                        ))}
                                    </div>
                                </details>
                            )
                        })()}
                    </div>
                )
            })()}
            </AdvancedSection>

            {/* Context — human-readable fields only (Advanced only) */}
            <AdvancedSection>
            {contextItems.length > 0 && (
                <div className="rounded-sm border border-border/60 bg-surface-1/40 p-4">
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
            </AdvancedSection>

            {/* Execution steps — expandable (Advanced only) */}
            <AdvancedSection>
            {steps.length > 0 && (
                <div>
                    <p className="mb-3 text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-2">
                        <Zap className="h-3 w-3" />
                        Execution steps ({steps.length})
                    </p>
                    <div className="flex flex-col gap-2">
                        {steps.map((step) => (
                            <StepRow key={step.id} step={step} />
                        ))}
                    </div>
                </div>
            )}
            </AdvancedSection>

            {/* Phase 5 — raw step state debug viewer (Advanced only) */}
            <AdvancedSection>
                <RawStepsPanel taskId={task.id} />
            </AdvancedSection>
        </div>
    )
}
