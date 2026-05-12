// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useRef } from 'react'

// ── Event types mirrored from packages/agent/src/types.ts ────────────────────

export interface StepShellLineEvent {
    type: 'step.shell_line'
    taskId: string
    workspaceId: string
    label?: string
    line: string
    ts: number
}

export interface StepFileWriteEvent {
    type: 'step.file_write'
    taskId: string
    workspaceId: string
    path: string
    patch: string
    ts: number
}

export interface StepScreenshotEvent {
    type: 'step.screenshot'
    taskId: string
    workspaceId: string
    dataUrl: string
    label: string
    ts: number
}

export interface StepTestResultEvent {
    type: 'step.test_result'
    taskId: string
    workspaceId: string
    pass: boolean
    name: string
    detail: string
    ts: number
}

export type StepEvent =
    | StepShellLineEvent
    | StepFileWriteEvent
    | StepScreenshotEvent
    | StepTestResultEvent

export interface UseCodeStreamOptions {
    workspaceId: string
    taskId?: string
    onShellLine?: (e: StepShellLineEvent) => void
    onFileWrite?: (e: StepFileWriteEvent) => void
    onScreenshot?: (e: StepScreenshotEvent) => void
    onTestResult?: (e: StepTestResultEvent) => void
}

/**
 * Subscribes to the existing SSE endpoint and dispatches step.* events
 * to the provided handlers. Reconnects automatically on close.
 */
export function useCodeStream({
    workspaceId,
    taskId,
    onShellLine,
    onFileWrite,
    onScreenshot,
    onTestResult,
}: UseCodeStreamOptions): void {
    const handlersRef = useRef({ onShellLine, onFileWrite, onScreenshot, onTestResult })
    const taskIdRef = useRef(taskId)

    useEffect(() => {
        handlersRef.current = { onShellLine, onFileWrite, onScreenshot, onTestResult }
        taskIdRef.current = taskId
    })

    useEffect(() => {
        if (!workspaceId) return

        let es: EventSource | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let destroyed = false

        function connect() {
            if (destroyed) return
            es = new EventSource(`/api/v1/sse?workspaceId=${workspaceId}`)

            es.onmessage = (ev) => {
                let data: unknown
                try { data = JSON.parse(ev.data as string) } catch { return }
                if (typeof data !== 'object' || data === null) return
                const event = data as Record<string, unknown>
                const type = event.type as string

                // Filter by taskId if provided
                const eid = event.taskId as string | undefined
                if (taskIdRef.current && eid && eid !== taskIdRef.current) return

                const handlers = handlersRef.current
                switch (type) {
                    case 'step.shell_line':
                        handlers.onShellLine?.(data as StepShellLineEvent)
                        break
                    case 'step.file_write':
                        handlers.onFileWrite?.(data as StepFileWriteEvent)
                        break
                    case 'step.screenshot':
                        handlers.onScreenshot?.(data as StepScreenshotEvent)
                        break
                    case 'step.test_result':
                        handlers.onTestResult?.(data as StepTestResultEvent)
                        break
                }
            }

            es.onerror = () => {
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
}
