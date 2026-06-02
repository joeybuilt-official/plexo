// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'

// Mirrors AgentSnapshotItem in apps/api/src/routes/agents-active-stream.ts
export interface ActiveAgent {
    id: string
    role: string
    status: string
    parentId: string | null
    outcomeSummary: string | null
    step: {
        stepNumber: number
        stepType: string | null
        state: string
        summary: string
    } | null
}

export interface UseActiveAgentsStream {
    agents: ActiveAgent[]
    connected: boolean
    /** ms timestamp of the last snapshot, or null before the first. */
    updatedAt: number | null
}

/**
 * Workspace "agents in action" feed. Consumes the continuous SSE snapshot at
 * GET /api/v1/agents/active/stream and replaces the agent list each tick.
 */
export function useActiveAgentsStream(workspaceId: string): UseActiveAgentsStream {
    const [agents, setAgents] = useState<ActiveAgent[]>([])
    const [connected, setConnected] = useState(false)
    const [updatedAt, setUpdatedAt] = useState<number | null>(null)

    useEffect(() => {
        if (!workspaceId) return

        let es: EventSource | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let destroyed = false

        function connect() {
            if (destroyed) return
            es = new EventSource(`/api/v1/agents/active/stream?workspaceId=${workspaceId}`)

            es.onopen = () => setConnected(true)

            es.onmessage = (ev) => {
                let msg: { type?: string; data?: ActiveAgent[]; ts?: number }
                try {
                    msg = JSON.parse(ev.data as string)
                } catch {
                    return
                }
                if (msg.type === 'agents' && Array.isArray(msg.data)) {
                    setAgents(msg.data)
                    setUpdatedAt(msg.ts ?? Date.now())
                }
            }

            es.onerror = () => {
                setConnected(false)
                es?.close()
                es = null
                if (!destroyed) {
                    reconnectTimer = setTimeout(connect, 3000)
                }
            }
        }

        connect()
        return () => {
            destroyed = true
            if (reconnectTimer) clearTimeout(reconnectTimer)
            es?.close()
        }
    }, [workspaceId])

    return { agents, connected, updatedAt }
}
