// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSE streaming helper — wraps EventSource for Node.js.
 * Used by `--wait`, `task logs`, `sprint logs`, `plexo logs`.
 */
import { EventSource } from 'eventsource'
import type { PlexoProfile } from './config.js'

export interface SseEvent {
    type: string
    data: unknown
}

type EventHandler = (event: SseEvent) => void

/**
 * Open an SSE connection and call handler for each event.
 * Returns a teardown function.
 */
export function openSse(
    profile: PlexoProfile,
    onEvent: EventHandler,
    onError?: (err: unknown) => void,
): () => void {
    const qs = new URLSearchParams({
        workspaceId: profile.workspace,
        userId: profile.userId,
        token: profile.token,
    })
    const es = new EventSource(`${profile.host.replace(/\/$/, '')}/api/sse?${qs}`)

    es.onmessage = (e: MessageEvent) => {
        try {
            const data = JSON.parse(e.data as string) as SseEvent
            onEvent(data)
        } catch {
            // Heartbeats and non-JSON lines are ignored
        }
    }

    es.onerror = (err: Event) => {
        onError?.(err)
    }

    return () => es.close()
}

/**
 * Wait for a specific task to reach a terminal state.
 * Streams steps to stdout. Resolves with final status string.
 */
export function waitForTask(
    profile: PlexoProfile,
    taskId: string,
    timeoutMs: number,
    onStep: (msg: string) => void,
): Promise<{ status: string; qualityScore: number | null }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            close()
            reject(new Error('TIMEOUT'))
        }, timeoutMs)

        const close = openSse(profile, (event) => {
            // Filter to this task's events
            const data = event.data as { taskId?: string; id?: string; status?: string; qualityScore?: number; message?: string }
            const isThisTask = data?.taskId === taskId || data?.id === taskId
            if (!isThisTask) return

            if (event.type === 'task.step' || event.type === 'step') {
                if (data.message) onStep(data.message)
            }

            if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.blocked') {
                clearTimeout(timeout)
                close()
                resolve({ status: data.status ?? event.type.replace('task.', ''), qualityScore: data.qualityScore ?? null })
            }
        }, (err) => {
            clearTimeout(timeout)
            reject(err)
        })
    })
}

/**
 * Wait for a sprint to complete. Streams worker output.
 */
export function waitForSprint(
    profile: PlexoProfile,
    sprintId: string,
    timeoutMs: number,
    onMessage: (msg: string) => void,
): Promise<{ status: string }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            close()
            reject(new Error('TIMEOUT'))
        }, timeoutMs)

        const close = openSse(profile, (event) => {
            const data = event.data as { sprintId?: string; id?: string; status?: string; message?: string }
            const isThisSprint = data?.sprintId === sprintId || data?.id === sprintId
            if (!isThisSprint) return

            if (data.message) onMessage(data.message)

            if (event.type === 'sprint.completed' || event.type === 'sprint.failed' || event.type === 'sprint.cancelled') {
                clearTimeout(timeout)
                close()
                resolve({ status: data.status ?? event.type.replace('sprint.', '') })
            }
        }, (err) => {
            clearTimeout(timeout)
            reject(err)
        })
    })
}
