// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type React from 'react'
import {
    Clock,
    Play,
    Cpu,
    XCircle,
    StopCircle,
    Sparkles,
    CheckCheck,
    AlertTriangle,
    Layers,
    Terminal,
    CircleDot,
    HandMetal,
} from 'lucide-react'

export type StatusKey =
    | 'pending' | 'queued' | 'claimed' | 'running' | 'blocked' | 'complete' | 'failed' | 'cancelled'
    | 'planning' | 'finalizing' | 'waiting' | 'partial'

export interface StatusConfig {
    label: string
    color: string
    bgColor: string
    borderColor: string
    dotColor: string
    icon: React.ComponentType<{ className?: string }>
    animate?: boolean
}

export const STATUS_MAP: Record<StatusKey, StatusConfig> = {
    pending: {
        label: 'Pending',
        color: 'text-text-muted',
        bgColor: 'bg-surface-2/40',
        borderColor: 'border-border/40',
        dotColor: 'bg-zinc-500',
        icon: Clock,
    },
    queued: {
        label: 'Queued',
        color: 'text-text-secondary',
        bgColor: 'bg-surface-2/60',
        borderColor: 'border-border/60',
        dotColor: 'bg-zinc-400',
        icon: Terminal,
    },
    claimed: {
        label: 'Claimed',
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10',
        borderColor: 'border-blue-500/20',
        dotColor: 'bg-blue-400',
        icon: Play,
    },
    running: {
        label: 'Running',
        color: 'text-azure',
        bgColor: 'bg-azure-dim/30',
        borderColor: 'border-azure/30',
        dotColor: 'bg-azure',
        icon: Cpu,
        animate: true,
    },
    blocked: {
        label: 'Blocked',
        color: 'text-amber',
        bgColor: 'bg-amber-dim/30',
        borderColor: 'border-amber/30',
        dotColor: 'bg-amber',
        icon: AlertTriangle,
    },
    complete: {
        label: 'Complete',
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
        borderColor: 'border-emerald-500/30',
        dotColor: 'bg-emerald-400',
        icon: CheckCheck,
    },
    failed: {
        label: 'Failed',
        color: 'text-red',
        bgColor: 'bg-red-dim/30',
        borderColor: 'border-red-500/30',
        dotColor: 'bg-red',
        icon: XCircle,
    },
    cancelled: {
        label: 'Cancelled',
        color: 'text-text-muted',
        bgColor: 'bg-surface-2/20',
        borderColor: 'border-border/20',
        dotColor: 'bg-surface-3',
        icon: StopCircle,
    },
    planning: {
        label: 'Planning',
        color: 'text-purple-400',
        bgColor: 'bg-purple-500/10',
        borderColor: 'border-purple-500/20',
        dotColor: 'bg-purple-400',
        icon: Sparkles,
        animate: true,
    },
    finalizing: {
        label: 'Finalizing',
        color: 'text-cyan-400',
        bgColor: 'bg-cyan-500/10',
        borderColor: 'border-cyan-500/20',
        dotColor: 'bg-cyan-400',
        icon: Layers,
        animate: true,
    },
    waiting: {
        label: 'Waiting',
        color: 'text-yellow-400',
        bgColor: 'bg-yellow-500/10',
        borderColor: 'border-yellow-500/30',
        dotColor: 'bg-yellow-400',
        icon: HandMetal,
        animate: true,
    },
    partial: {
        label: 'Partial',
        color: 'text-yellow-400',
        bgColor: 'bg-yellow-500/10',
        borderColor: 'border-yellow-500/20',
        dotColor: 'bg-yellow-400',
        icon: CircleDot,
    },
}
