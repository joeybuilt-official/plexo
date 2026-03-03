'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Invisible component that:
 * 1. Opens an EventSource to the SSE stream
 * 2. Calls router.refresh() whenever a task:* event is received
 *    (task started, completed, failed, etc.)
 * 3. Falls back to polling every 15s if SSE fails or is unavailable
 *
 * Mounts once per dashboard layout render. No visible UI.
 */
export function DashboardRefresher() {
    const router = useRouter()
    const sseRef = useRef<EventSource | null>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
    const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

    useEffect(() => {
        let failed = false

        function startPolling() {
            if (pollRef.current) return
            pollRef.current = setInterval(() => router.refresh(), 15_000)
        }

        function connectSSE() {
            if (!workspaceId) {
                startPolling()
                return
            }

            const url = `${apiBase}/api/sse?workspaceId=${encodeURIComponent(workspaceId)}`
            const es = new EventSource(url)
            sseRef.current = es

            es.onopen = () => {
                // Cancel fallback polling if SSE connects
                if (pollRef.current) {
                    clearInterval(pollRef.current)
                    pollRef.current = null
                }
                failed = false
            }

            // Refresh on any task lifecycle event
            const REFRESH_EVENTS = [
                'task:started',
                'task:completed',
                'task:failed',
                'task:cancelled',
                'task:step',
                'sprint:updated',
            ]
            for (const ev of REFRESH_EVENTS) {
                es.addEventListener(ev, () => router.refresh())
            }

            es.onerror = () => {
                if (!failed) {
                    failed = true
                    es.close()
                    sseRef.current = null
                    // Reconnect after 5s; fall back to polling while waiting
                    startPolling()
                    setTimeout(() => {
                        if (pollRef.current) {
                            clearInterval(pollRef.current)
                            pollRef.current = null
                        }
                        connectSSE()
                    }, 5_000)
                }
            }
        }

        connectSSE()

        return () => {
            sseRef.current?.close()
            sseRef.current = null
            if (pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
            }
        }
    }, [apiBase, workspaceId, router])

    return null
}
