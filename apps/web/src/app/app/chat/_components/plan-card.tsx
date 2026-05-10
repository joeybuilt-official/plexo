// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ShieldAlert, Loader2 } from 'lucide-react'
import {
    PLAN_HEADING,
    PLAN_PROCEED_LABEL,
    PLAN_REJECT_LABEL,
    PLAN_AUTO_NOTE,
    formatDuration,
    formatConfidence,
    humanizeToolName,
} from '@web/lib/plan-step-copy'

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

export interface PlanProposalStep {
    stepNumber: number
    description: string
    toolsRequired: string[]
    verificationMethod?: string
    isOneWayDoor: boolean
    depends_on?: number[]
}

export interface PlanProposalOneWayDoor {
    description: string
    type: string
    reversibility: string
    requiresApproval: boolean
}

export interface PlanProposalPlan {
    goal: string
    steps: PlanProposalStep[]
    oneWayDoors: PlanProposalOneWayDoor[]
    estimatedDurationMs?: number
    confidenceScore?: number
    risks: string[]
}

export type PlanCardMode = 'chat' | 'detail-readonly'

export interface PlanCardProps {
    taskId: string
    plan: PlanProposalPlan
    requiresApproval: boolean
    approvalId: string | null
    /**
     * 'chat' (default) — full interactive proposal card with Proceed/Reject and the
     * "auto-execute" footer note. Used in the chat stream.
     * 'detail-readonly' — render the same plan summary (goal/steps/OWDs/risks) but
     * hide all action affordances and the auto-note. Used by the work-detail page
     * for tasks where the plan is already accepted, in-progress, or completed.
     */
    mode?: PlanCardMode
}

type Decision = 'approve' | 'reject'
type DecisionStatus = 'idle' | 'pending' | 'approved' | 'rejected'

export function PlanCard({ taskId, plan, requiresApproval, approvalId, mode = 'chat' }: PlanCardProps) {
    const [status, setStatus] = useState<DecisionStatus>('idle')
    const [errorMsg, setErrorMsg] = useState<string | null>(null)
    const proceedRef = useRef<HTMLButtonElement | null>(null)

    const readonly = mode === 'detail-readonly'
    const headingId = `plan-card-${taskId}`
    const showActions = !readonly && requiresApproval && approvalId !== null
    const pending = status === 'pending'

    useEffect(() => {
        if (showActions && status === 'idle') {
            proceedRef.current?.focus()
        }
    }, [showActions, status])

    async function decide(action: Decision) {
        if (!approvalId || pending) return
        setErrorMsg(null)
        setStatus('pending')
        try {
            const res = await fetch(`${API}/api/v1/approvals/${approvalId}/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'chat' }),
            })
            if (res.ok) {
                setStatus(action === 'approve' ? 'approved' : 'rejected')
            } else {
                const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setErrorMsg(err.error?.message ?? `${action} failed (${res.status})`)
                setStatus('idle')
            }
        } catch {
            setErrorMsg('Network error — please retry')
            setStatus('idle')
        }
    }

    const confidenceLabel = typeof plan.confidenceScore === 'number'
        ? formatConfidence(plan.confidenceScore)
        : null
    const durationLabel = typeof plan.estimatedDurationMs === 'number'
        ? formatDuration(plan.estimatedDurationMs)
        : null
    const owdSteps = plan.steps.filter((s) => s.isOneWayDoor).length

    return (
        <section
            role="region"
            aria-labelledby={headingId}
            aria-busy={pending || undefined}
            className="w-full rounded-sm border border-border/50 bg-surface-1/40 px-4 py-3 text-[14px] text-text-primary"
        >
            <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 id={headingId} className="text-[13px] font-medium uppercase tracking-wide text-text-secondary">
                    {PLAN_HEADING}
                </h3>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    {durationLabel && (
                        <span aria-label={`Estimated duration ${durationLabel}`}>~{durationLabel}</span>
                    )}
                    {confidenceLabel && (
                        <span aria-label={`Confidence ${confidenceLabel}`}>{confidenceLabel} confidence</span>
                    )}
                    {owdSteps > 0 && (
                        <span
                            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-px text-amber-300"
                            aria-label={`${owdSteps} one-way door step${owdSteps === 1 ? '' : 's'}`}
                        >
                            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                            {owdSteps} OWD
                        </span>
                    )}
                </div>
            </header>

            <p className="mb-3 leading-snug text-text-primary">{plan.goal}</p>

            <ol className="mb-3 space-y-2">
                {plan.steps.map((step) => (
                    <li
                        key={step.stepNumber}
                        className="rounded-sm border border-border/30 bg-surface-2/40 p-2"
                    >
                        <div className="flex items-start gap-2">
                            <span className="shrink-0 rounded bg-surface-2/80 px-1.5 py-px font-mono text-[11px] text-text-muted">
                                {step.stepNumber}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="leading-snug text-text-primary">{step.description}</span>
                                {(step.toolsRequired.length > 0 || step.isOneWayDoor) && (
                                    <div className="flex flex-wrap items-center gap-1">
                                        {step.toolsRequired.map((tool) => {
                                            const label = humanizeToolName(tool)
                                            return (
                                                <span
                                                    key={tool}
                                                    aria-label={`Tool: ${label}`}
                                                    className="rounded bg-surface-2/80 px-1.5 py-px text-[10px] text-text-secondary"
                                                >
                                                    {label}
                                                </span>
                                            )
                                        })}
                                        {step.isOneWayDoor && (
                                            <span
                                                aria-label="One-way door — requires approval"
                                                className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-300"
                                            >
                                                <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                                                one-way door
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>

            {plan.risks.length > 0 && (
                <div className="mb-3 flex items-start gap-1.5 rounded-sm border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[12px] text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    <ul className="flex-1 space-y-0.5">
                        {plan.risks.map((risk, i) => (
                            <li key={i}>{risk}</li>
                        ))}
                    </ul>
                </div>
            )}

            {showActions && status === 'idle' && (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        ref={proceedRef}
                        type="button"
                        aria-label={PLAN_PROCEED_LABEL}
                        disabled={pending}
                        onClick={() => void decide('approve')}
                        className="rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors"
                    >
                        {PLAN_PROCEED_LABEL}
                    </button>
                    <button
                        type="button"
                        aria-label={PLAN_REJECT_LABEL}
                        disabled={pending}
                        onClick={() => void decide('reject')}
                        className="rounded-sm border border-border/60 bg-surface-2/60 px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50 transition-colors"
                    >
                        {PLAN_REJECT_LABEL}
                    </button>
                </div>
            )}

            {showActions && pending && (
                <div className="flex items-center gap-2 text-[12px] text-text-muted" aria-live="polite">
                    <Loader2 className="h-3 w-3 animate-spin text-azure" aria-hidden="true" />
                    Submitting…
                </div>
            )}

            {status === 'approved' && (
                <div className="flex items-center gap-1.5 text-[12px] text-emerald-300" aria-live="polite">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    Approved — running…
                </div>
            )}

            {status === 'rejected' && (
                <div className="flex items-center gap-1.5 text-[12px] text-text-muted" aria-live="polite">
                    Rejected
                </div>
            )}

            {!readonly && !requiresApproval && (
                <p className="text-[12px] italic text-text-muted">{PLAN_AUTO_NOTE}</p>
            )}

            {errorMsg && (
                <div role="alert" className="mt-2 rounded-sm border border-red-800/50 bg-red-dim px-2 py-1.5 text-[12px] text-red">
                    {errorMsg}
                </div>
            )}
        </section>
    )
}
