// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { CheckCircle2, AlertTriangle, XCircle, CircleDot } from 'lucide-react'
import { WorkItem } from './work-item'
import { VerificationChecklist } from './verification-checklist'

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

const outcomeMeta: Record<TaskDeliverable['outcome'], { icon: typeof CheckCircle2; label: string; badge: string; border: string; bg: string }> = {
    completed: {
        icon: CheckCircle2,
        label: 'Completed',
        badge: 'bg-emerald-900/30 text-emerald-400',
        border: 'border-emerald-500/20',
        bg: 'bg-emerald-500/5',
    },
    partial: {
        icon: CircleDot,
        label: 'Partial',
        badge: 'bg-yellow-900/30 text-yellow-400',
        border: 'border-yellow-500/20',
        bg: 'bg-yellow-500/5',
    },
    blocked: {
        icon: AlertTriangle,
        label: 'Blocked',
        badge: 'bg-amber-900/30 text-amber-400',
        border: 'border-amber-500/20',
        bg: 'bg-amber-500/5',
    },
    failed: {
        icon: XCircle,
        label: 'Failed',
        badge: 'bg-red-900/30 text-red-400',
        border: 'border-red-500/20',
        bg: 'bg-red-500/5',
    },
}

export function WorksPanel({ deliverable }: { deliverable: TaskDeliverable }) {
    const meta = outcomeMeta[deliverable.outcome]
    const Icon = meta.icon

    return (
        <div className={`rounded-xl border ${meta.border} ${meta.bg} p-4`}>
            <div className="flex items-center gap-2 mb-3">
                <Icon className={`h-3.5 w-3.5 ${meta.badge.split(' ')[1]}`} />
                <p className={`text-[11px] font-medium uppercase tracking-wider ${meta.badge.split(' ')[1]}`}>Deliverable</p>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-mono ${meta.badge}`}>{meta.label}</span>
            </div>

            <p className="text-sm text-text-primary leading-relaxed mb-3">{deliverable.summary}</p>

            {deliverable.works.length > 0 && (
                <div className="flex flex-col gap-1.5 mb-3">
                    <p className="text-[10px] text-text-muted uppercase tracking-wider">Work products</p>
                    {deliverable.works.map((w, i) => (
                        <WorkItem key={i} work={w} />
                    ))}
                </div>
            )}

            {deliverable.verificationSteps.length > 0 && (
                <VerificationChecklist steps={deliverable.verificationSteps} />
            )}
        </div>
    )
}
