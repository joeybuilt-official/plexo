// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, WifiOff } from 'lucide-react'
import { StatusBadge } from '@plexo/ui'
import { LiveSteps } from '../../tasks/[id]/_live-steps'
import { useActiveAgentsStream, type ActiveAgent } from './use-active-agents-stream'

function AgentNode({
    agent,
    childrenByParent,
    workspaceId,
    depth,
}: {
    agent: ActiveAgent
    childrenByParent: Map<string, ActiveAgent[]>
    workspaceId: string
    depth: number
}) {
    const [open, setOpen] = useState(false)
    const kids = childrenByParent.get(agent.id) ?? []

    return (
        <div className="flex flex-col gap-2">
            <div
                className="rounded-sm border border-border bg-surface-1/30 overflow-hidden"
                style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
            >
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} agent ${agent.role}`}
                    className="flex items-center gap-2 w-full p-3 text-left hover:bg-surface-2/30 transition-colors"
                >
                    {open ? (
                        <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
                    ) : (
                        <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
                    )}
                    <span className="rounded border border-azure-800/40 bg-azure/30 px-1.5 py-0.5 text-[11px] font-mono text-azure shrink-0">
                        {agent.role}
                    </span>
                    <StatusBadge status={agent.status} />
                    <span className="text-[11px] text-text-muted truncate">
                        {agent.step
                            ? `${agent.step.stepType ?? 'step'} · ${agent.step.summary || '…'}`
                            : 'Starting up…'}
                    </span>
                </button>

                {open && (
                    <div className="border-t border-border p-3">
                        <LiveSteps taskId={agent.id} workspaceId={workspaceId} />
                    </div>
                )}
            </div>

            {kids.map((k) => (
                <AgentNode key={k.id} agent={k} childrenByParent={childrenByParent} workspaceId={workspaceId} depth={depth + 1} />
            ))}
        </div>
    )
}

/**
 * Workspace "agents in action" — live tree of in-flight tasks. Fan-out children
 * and critic tasks (linked via parentId) nest under their parent so multi-agent
 * interactions are visible. Each agent expands to its live step detail.
 */
export function ActiveAgentsLive({ workspaceId }: { workspaceId: string }) {
    const { agents, connected, updatedAt, phase, error } = useActiveAgentsStream(workspaceId)

    // First connect, no snapshot yet — show a loading state rather than the
    // "nothing in flight" empty state (which would falsely imply we know it's
    // empty before the feed has answered).
    if (phase === 'connecting') {
        return (
            <div className="flex items-center gap-2 text-[11px] text-text-muted" role="status" aria-live="polite">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                Connecting to the live feed…
            </div>
        )
    }

    const activeIds = new Set(agents.map((a) => a.id))
    const childrenByParent = new Map<string, ActiveAgent[]>()
    for (const a of agents) {
        if (a.parentId && activeIds.has(a.parentId)) {
            const arr = childrenByParent.get(a.parentId) ?? []
            arr.push(a)
            childrenByParent.set(a.parentId, arr)
        }
    }
    // Roots = no parent, or a parent that is no longer active (so it still shows).
    const roots = agents.filter((a) => !a.parentId || !activeIds.has(a.parentId))

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}
                />
                <span className="text-[11px] uppercase tracking-wider text-text-muted" aria-live="polite">
                    {agents.length === 0
                        ? 'No agents working right now'
                        : `${agents.length} agent${agents.length === 1 ? '' : 's'} in action`}
                </span>
                {updatedAt && (
                    <span className="text-[11px] text-text-muted ml-auto">
                        updated {new Date(updatedAt).toLocaleTimeString()}
                    </span>
                )}
            </div>

            {phase === 'reconnecting' && (
                <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-sm border border-amber-500/30 bg-amber-dim px-3 py-2 text-[11px] font-medium text-amber-300"
                >
                    <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden="true" />
                    Lost the live feed — reconnecting… (showing the last known state)
                </div>
            )}

            {error && (
                <div
                    role="alert"
                    className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-300"
                >
                    {error} — retrying automatically.
                </div>
            )}

            {roots.length === 0 ? (
                <p className="text-[11px] text-text-muted">Nothing in flight. New work will appear here as it starts.</p>
            ) : (
                // role=log + aria-live so SR users hear agents enter/leave the
                // live stream (UX3 — the SSE feed was previously silent to AT).
                <div className="flex flex-col gap-2" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Active agents">
                    {roots.map((a) => (
                        <AgentNode key={a.id} agent={a} childrenByParent={childrenByParent} workspaceId={workspaceId} depth={0} />
                    ))}
                </div>
            )}
        </div>
    )
}
