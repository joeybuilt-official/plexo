// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import {
    Activity,
    AlertTriangle,
    CheckCircle,
    Clock,
    FileText,
    Loader2,
    Pause,
    Play,
    RefreshCw,
    ShieldAlert,
    XCircle,
    Zap,
    type LucideIcon,
} from 'lucide-react'
import {
    formatAbsoluteTime,
    formatRelativeTime,
    humanizeEventType,
    humanizeStateTransition,
    humanizeTaskStatus,
} from '@web/lib/lifecycle-copy'

export interface LifecycleEvent {
    id: string
    eventType: string
    fromState: string | null
    toState: string | null
    metadata: unknown
    recordedAt: string
}

const ICON_MAP: Record<string, LucideIcon> = {
    claimed: Zap,
    resumed: Play,
    planning: FileText,
    plan_proposed: FileText,
    executing: Activity,
    awaiting_approval: Clock,
    approval_granted: ShieldAlert,
    approval_rejected: XCircle,
    approval_timeout: Clock,
    complete: CheckCircle,
    completed: CheckCircle,
    failed: XCircle,
    blocked: AlertTriangle,
    cancelled: Pause,
    requeued: RefreshCw,
    claim_timeout: Clock,
    wall_clock_exceeded: Clock,
    ghost_recovery: RefreshCw,
    manual_requeue: RefreshCw,
    manual_cancel: Pause,
}

function iconFor(eventType: string): LucideIcon {
    return ICON_MAP[eventType] ?? Loader2
}

function colorFor(eventType: string): string {
    if (eventType === 'complete' || eventType === 'completed' || eventType === 'approval_granted') return 'text-emerald-400'
    if (eventType === 'failed' || eventType === 'approval_rejected' || eventType === 'approval_timeout' || eventType === 'wall_clock_exceeded') return 'text-red-400'
    if (eventType === 'blocked' || eventType === 'awaiting_approval' || eventType === 'claim_timeout') return 'text-amber-400'
    return 'text-text-secondary'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function formatMetadataLine(eventType: string, metadata: unknown): string | null {
    if (!isPlainObject(metadata)) return null
    const md = metadata
    const parts: string[] = []

    if (eventType === 'claim_timeout' && typeof md.claimed_until === 'string') {
        parts.push(`claim expired at ${formatAbsoluteTime(md.claimed_until)}`)
    }
    if (typeof md.reason === 'string' && md.reason !== eventType) {
        parts.push(md.reason.replace(/_/g, ' '))
    }
    if (typeof md.error === 'string') parts.push(md.error)
    if (typeof md.steps === 'number') parts.push(`${md.steps} step${md.steps === 1 ? '' : 's'}`)
    if (typeof md.durationMs === 'number') parts.push(`${(md.durationMs / 1000).toFixed(1)}s`)
    if (typeof md.costUsd === 'number') parts.push(`$${md.costUsd.toFixed(5)}`)
    if (typeof md.decidedBy === 'string') parts.push(`by ${md.decidedBy}`)
    if (typeof md.alternatives === 'number') parts.push(`${md.alternatives} alternative${md.alternatives === 1 ? '' : 's'}`)
    if (typeof md.priorStatus === 'string') parts.push(`prior: ${md.priorStatus}`)
    if (typeof md.outcome === 'string') parts.push(md.outcome)
    if (typeof md.retryResult === 'string') parts.push(`retry: ${md.retryResult.replace(/_/g, ' ')}`)
    if (typeof md.code === 'string') parts.push(md.code)

    return parts.length > 0 ? parts.join(' · ') : null
}

export function LifecycleTimeline({ events }: { events: LifecycleEvent[] }) {
    const headingId = 'lifecycle-heading'

    if (events.length === 0) {
        return (
            <section role="region" aria-labelledby={headingId} className="rounded-sm border border-border/60 bg-surface-1/40 p-4">
                <h2 id={headingId} className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    Timeline
                </h2>
                <p className="text-sm text-text-muted">No lifecycle events recorded for this task.</p>
            </section>
        )
    }

    return (
        <section role="region" aria-labelledby={headingId} className="rounded-sm border border-border/60 bg-surface-1/40 p-4">
            <h2 id={headingId} className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-muted flex items-center gap-2">
                <Activity className="h-3 w-3" aria-hidden="true" />
                Timeline ({events.length})
            </h2>
            <ol role="list" className="flex flex-col gap-1.5">
                {events.map((e) => {
                    const Icon = iconFor(e.eventType)
                    const color = colorFor(e.eventType)
                    const copy = humanizeEventType(e.eventType)
                    const transition = humanizeStateTransition(e.fromState, e.toState)
                    const hasBothStates = e.fromState !== null && e.toState !== null && e.fromState !== e.toState
                    const fromHumanized = e.fromState ? humanizeTaskStatus(e.fromState) : null
                    const toHumanized = e.toState ? humanizeTaskStatus(e.toState) : null
                    const detail = formatMetadataLine(e.eventType, e.metadata)
                    return (
                        <li
                            key={e.id}
                            className="flex items-start gap-2.5 rounded-sm border border-border/30 bg-surface-0/40 px-3 py-2"
                        >
                            <span className={`mt-0.5 shrink-0 ${color}`} aria-hidden="true">
                                <Icon className="h-3.5 w-3.5" />
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                    <span className="text-sm text-text-primary leading-snug">
                                        {copy.label}
                                        {transition && (
                                            <span className="ml-2 text-[11px] font-mono text-text-muted">
                                                {hasBothStates && fromHumanized && toHumanized ? (
                                                    <>
                                                        <span aria-hidden="true">{transition}</span>
                                                        <span className="sr-only"> from {fromHumanized} to {toHumanized}</span>
                                                    </>
                                                ) : (
                                                    transition
                                                )}
                                            </span>
                                        )}
                                    </span>
                                    <time
                                        dateTime={e.recordedAt}
                                        title={formatAbsoluteTime(e.recordedAt)}
                                        className="shrink-0 text-[11px] text-text-muted font-mono"
                                    >
                                        {formatRelativeTime(e.recordedAt)}
                                    </time>
                                </div>
                                {copy.description && (
                                    <span className="text-[12px] text-text-muted leading-snug">{copy.description}</span>
                                )}
                                {detail && (
                                    <span className="text-[12px] text-text-muted leading-snug break-words">{detail}</span>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ol>
        </section>
    )
}
