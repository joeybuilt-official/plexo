// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { 
    Clock, 
    Play, 
    Cpu, 
    AlertCircle, 
    CheckCircle2, 
    XCircle, 
    StopCircle,
    Sparkles,
    CheckCheck,
    AlertTriangle,
    Layers,
    Terminal
} from 'lucide-react'

export type StatusKey = 
    | 'pending' | 'queued' | 'claimed' | 'running' | 'blocked' | 'complete' | 'failed' | 'cancelled'
    | 'planning' | 'finalizing'

export interface StatusConfig {
    label: string
    color: string
    bgColor: string
    borderColor: string
    dotColor: string
    icon: any
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
        color: 'text-azure',
        bgColor: 'bg-azure-dim/30',
        borderColor: 'border-azure/40',
        dotColor: 'bg-azure',
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
}
