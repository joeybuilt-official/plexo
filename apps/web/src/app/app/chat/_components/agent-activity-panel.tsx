// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { memo, useState } from 'react'
import {
    ChevronRight, ChevronDown, Loader2, CheckCircle2, XCircle, Circle, Users,
} from 'lucide-react'
import type { SprintActivity, SprintSubAgent } from './types'

/**
 * Agent Activity panel — surfaces the sub-agent / wave structure when a chat
 * task fanned out into a multi-agent sprint. Collapsed by default to a one-line
 * summary; expands to the live per-sub-agent state. Hidden for single-agent
 * tasks (no sprint).
 */

function statusIcon(status: string) {
    const s = status.toLowerCase()
    if (s === 'running' || s === 'in_progress') return <Loader2 className="w-3.5 h-3.5 text-azure animate-spin shrink-0" />
    if (s === 'complete' || s === 'completed' || s === 'done') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
    if (s === 'failed' || s === 'blocked' || s === 'error') return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
    return <Circle className="w-3.5 h-3.5 text-text-muted/50 shrink-0" />
}

function statusLabel(status: string): string {
    const s = status.toLowerCase()
    if (s === 'in_progress') return 'running'
    if (s === 'completed' || s === 'done') return 'complete'
    return s
}

function SubAgentRow({ agent }: { agent: SprintSubAgent }) {
    return (
        <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
            {statusIcon(agent.status)}
            <span className="text-text-secondary truncate">{agent.description || agent.branch || 'sub-agent'}</span>
            {agent.branch && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-text-muted/60 truncate max-w-[40%]">{agent.branch}</span>
            )}
            <span className="shrink-0 text-[10px] text-text-muted/80 tabular-nums">{statusLabel(agent.status)}</span>
        </div>
    )
}

function countByStatus(subAgents: SprintSubAgent[]) {
    let running = 0, done = 0, failed = 0
    for (const a of subAgents) {
        const s = a.status.toLowerCase()
        if (s === 'running' || s === 'in_progress') running++
        else if (s === 'complete' || s === 'completed' || s === 'done') done++
        else if (s === 'failed' || s === 'blocked' || s === 'error') failed++
    }
    return { running, done, failed }
}

function AgentActivityPanelBase({ sprint, isRunning }: { sprint: SprintActivity; isRunning: boolean }) {
    const [open, setOpen] = useState(false)

    if (!sprint.subAgents || sprint.subAgents.length === 0) return null

    const n = sprint.subAgents.length
    const { running, done, failed } = countByStatus(sprint.subAgents)
    const wave = sprint.currentWave

    const summary = (
        <>
            {wave && (
                <>
                    <span className="text-text-secondary">Wave {wave.index}/{wave.total}</span>
                    <span className="text-text-muted/40">·</span>
                </>
            )}
            <span>{n} agent{n !== 1 ? 's' : ''}</span>
            {running > 0 && <><span className="text-text-muted/40">·</span><span className="text-azure">{running} running</span></>}
            {done > 0 && <><span className="text-text-muted/40">·</span><span className="text-emerald-400">{done} done</span></>}
            {failed > 0 && <><span className="text-text-muted/40">·</span><span className="text-red-400">{failed} failed</span></>}
        </>
    )

    // ── Collapsed (default) ──────────────────────────────────────────────
    if (!open) {
        return (
            <div className="mb-1.5">
                <button
                    type="button"
                    aria-label="Show sub-agent activity"
                    onClick={() => setOpen(true)}
                    className="inline-flex items-center gap-2 rounded-md border border-border/30 bg-surface-1/30 hover:bg-surface-1/50 px-2 py-1 min-h-6 text-[11px] text-text-secondary transition-colors max-w-full"
                >
                    <ChevronRight className="w-3 h-3 shrink-0" />
                    {isRunning
                        ? <Loader2 className="w-3 h-3 text-azure animate-spin shrink-0" />
                        : <Users className="w-3 h-3 text-text-muted/70 shrink-0" />}
                    <span className="flex items-center gap-1.5 flex-wrap">{summary}</span>
                </button>
            </div>
        )
    }

    // ── Expanded ─────────────────────────────────────────────────────────
    return (
        <div className="mb-2 rounded-sm border border-border/40 bg-surface-1/30 overflow-hidden">
            <button
                type="button"
                aria-label="Hide sub-agent activity"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-surface-1/40 text-left"
            >
                <ChevronDown className="w-3 h-3 shrink-0 text-text-muted/70" />
                <Users className="w-3.5 h-3.5 text-text-muted/70 shrink-0" />
                <span className="text-[12px] font-medium text-text-primary">Agents</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] flex-wrap justify-end">{summary}</span>
            </button>
            <div className="max-h-64 overflow-y-auto py-1 px-1">
                {sprint.subAgents.map((a) => <SubAgentRow key={a.id} agent={a} />)}
            </div>
        </div>
    )
}

export const AgentActivityPanel = memo(AgentActivityPanelBase)
