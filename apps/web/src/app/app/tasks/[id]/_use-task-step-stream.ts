// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useRef, useState } from 'react'

// Raw task_steps row as emitted by GET /api/v1/tasks/:id/steps/stream
// ({ type: 'step', data: <row> }). Mirrors packages/db taskSteps columns.
export interface RawTaskStep {
    id: string
    stepNumber: number
    state?: string | null
    stepType?: string | null
    outcome?: string | null
    error?: string | null
    isTerminal?: boolean | null
    startedAt?: string | null
    completedAt?: string | null
    toolCalls?: unknown
}

export interface UseTaskStepStream {
    steps: RawTaskStep[]
    /** terminal status once the stream sends `done`, else null while live. */
    doneStatus: string | null
    connected: boolean
}

/**
 * Live feed of task_steps for a running task over the existing SSE endpoint.
 * Accumulates steps keyed by stepNumber (later rows replace earlier ones),
 * stops reconnecting once a terminal `done` arrives, and cleans up on unmount.
 */
export function useTaskStepStream(taskId: string, workspaceId: string): UseTaskStepStream {
    const [steps, setSteps] = useState<RawTaskStep[]>([])
    const [doneStatus, setDoneStatus] = useState<string | null>(null)
    const [connected, setConnected] = useState(false)

    useEffect(() => {
        if (!taskId || !workspaceId) return

        let es: EventSource | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let destroyed = false
        let finished = false

        function connect() {
            if (destroyed || finished) return
            es = new EventSource(`/api/v1/tasks/${taskId}/steps/stream?workspaceId=${workspaceId}`)

            es.onopen = () => setConnected(true)

            es.onmessage = (ev) => {
                let msg: { type?: string; data?: RawTaskStep; status?: string }
                try {
                    msg = JSON.parse(ev.data as string)
                } catch {
                    return
                }
                if (msg.type === 'step' && msg.data) {
                    const incoming = msg.data
                    setSteps((prev) => {
                        const next = prev.filter((s) => s.stepNumber !== incoming.stepNumber)
                        next.push(incoming)
                        next.sort((a, b) => a.stepNumber - b.stepNumber)
                        return next
                    })
                } else if (msg.type === 'done') {
                    finished = true
                    setDoneStatus(msg.status ?? 'complete')
                    setConnected(false)
                    es?.close()
                }
            }

            es.onerror = () => {
                setConnected(false)
                es?.close()
                es = null
                if (!destroyed && !finished) {
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
    }, [taskId, workspaceId])

    return { steps, doneStatus, connected }
}
