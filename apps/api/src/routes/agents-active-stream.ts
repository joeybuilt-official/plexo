// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace Active-Agents Stream
 *
 * GET /api/v1/agents/active/stream?workspaceId=<id>
 *
 * Server-Sent Events feed of the workspace's in-flight tasks (the "agents in
 * action" view). Polls every 2 s; unlike the per-task step stream this feed is
 * continuous (no terminal `done`) — it reflects whatever is active right now.
 *
 * Events:
 *   { type: 'agents', ts: <ms>, data: AgentSnapshotItem[] }
 *   { type: 'error', message: string }
 * Keepalive: ': ping' comment every 15 s
 *
 * Each item carries the task's role (type), status, parentId (for the
 * multi-agent tree), and a one-line summary of its current step.
 */

import { Router, type Router as ExpressRouter } from 'express'
import * as agentsActiveRepo from '../repositories/agents-active.repository.js'
import { logger } from '../logger.js'

export const agentsActiveStreamRouter: ExpressRouter = Router()

// In-flight, non-terminal statuses (task_status enum). Terminal = complete/
// completed/failed/cancelled; those drop out of the feed.
export const ACTIVE_STATUSES = ['queued', 'claimed', 'running'] as const

const STEP_SUMMARY_MAX = 160

// Poll cadence: 2s while agents are active, backing off to 10s when the
// workspace is idle so a roomful of open dashboards doesn't hammer the DB with
// 2s polls that always return nothing. Resets to BASE the moment work appears.
const POLL_BASE_MS = 2000
const POLL_MAX_MS = 10_000

// Per-workspace concurrent-stream cap. Each stream holds an interval + DB poll;
// an unbounded fan-out (many tabs / a reconnect storm) multiplies DB load.
const MAX_STREAMS_PER_WS = 8
const streamsPerWs = new Map<string, number>()

/**
 * Next poll gap given the current snapshot's active count and the previous gap.
 * Active → snap back to BASE; idle → grow 1.5× toward MAX. Pure for testing.
 */
export function nextPollCadence(activeCount: number, prevMs: number): number {
    if (activeCount > 0) return POLL_BASE_MS
    return Math.min(POLL_MAX_MS, Math.round(prevMs * 1.5))
}

export interface ActiveTaskRow {
    id: string
    role: string
    status: string
    parentId: string | null
    outcomeSummary: string | null
}

export interface LatestStep {
    stepNumber: number
    stepType: string | null
    state: string
    outcome: string | null
    error: string | null
}

export interface AgentSnapshotItem {
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

/**
 * Pure snapshot builder — exported for unit tests. Maps active tasks + their
 * latest step into the wire shape the UI renders.
 */
export function buildAgentsSnapshot(
    activeTasks: ActiveTaskRow[],
    latestStepByTask: Map<string, LatestStep>,
): AgentSnapshotItem[] {
    return activeTasks.map((t) => {
        const s = latestStepByTask.get(t.id)
        const summary = s ? (s.error ?? s.outcome ?? '') : ''
        return {
            id: t.id,
            role: t.role,
            status: t.status,
            parentId: t.parentId,
            outcomeSummary: t.outcomeSummary,
            step: s
                ? {
                      stepNumber: s.stepNumber,
                      stepType: s.stepType,
                      state: s.state,
                      summary: summary.slice(0, STEP_SUMMARY_MAX),
                  }
                : null,
        }
    })
}

agentsActiveStreamRouter.get('/active/stream', async (req, res) => {
    const workspaceId = (req.query as Record<string, string>).workspaceId
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query param required' } })
        return
    }
    const wsId: string = workspaceId

    // Reject excess concurrent streams before upgrading to SSE so the client
    // gets a clean 429 (the hook's onerror will retry with backoff).
    const current = streamsPerWs.get(wsId) ?? 0
    if (current >= MAX_STREAMS_PER_WS) {
        res.status(429).json({ error: { code: 'TOO_MANY_STREAMS', message: 'Too many active streams for this workspace' } })
        return
    }
    streamsPerWs.set(wsId, current + 1)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    let closed = false

    // Returns the number of active agents in this snapshot so the scheduler can
    // adapt cadence (0 → back off, >0 → poll fast).
    async function poll(): Promise<number> {
        if (closed) return 0
        try {
            const active = await agentsActiveRepo.listActiveTasks(wsId, [...ACTIVE_STATUSES])

            const latestByTask = new Map<string, LatestStep>()
            if (active.length > 0) {
                const ids = active.map((t) => t.id)
                const steps = await agentsActiveRepo.listStepsForTasks(ids)
                for (const s of steps) {
                    // First row per taskId wins (steps are ordered stepNumber DESC).
                    if (!latestByTask.has(s.taskId)) {
                        latestByTask.set(s.taskId, {
                            stepNumber: s.stepNumber,
                            stepType: s.stepType,
                            state: s.state,
                            outcome: s.outcome,
                            error: s.error,
                        })
                    }
                }
            }

            const snapshot = buildAgentsSnapshot(active as ActiveTaskRow[], latestByTask)
            res.write(`data: ${JSON.stringify({ type: 'agents', ts: Date.now(), data: snapshot })}\n\n`)
            return snapshot.length
        } catch (err) {
            logger.error({ err, workspaceId: wsId }, 'agents-active-stream poll error')
            if (!closed) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal poll error' })}\n\n`)
            }
            return 0
        }
    }

    let cadence = POLL_BASE_MS
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    // Self-rescheduling loop (instead of a fixed setInterval) so the gap between
    // polls can grow while the workspace is idle and snap back when work starts.
    async function tick() {
        if (closed) return
        const activeCount = await poll()
        if (closed) return
        cadence = nextPollCadence(activeCount, cadence)
        pollTimer = setTimeout(() => void tick(), cadence)
    }

    await tick()

    const pingTimer = setInterval(() => {
        if (!closed) res.write(': ping\n\n')
    }, 15000)

    req.on('close', () => {
        closed = true
        if (pollTimer) clearTimeout(pollTimer)
        clearInterval(pingTimer)
        const n = (streamsPerWs.get(wsId) ?? 1) - 1
        if (n <= 0) streamsPerWs.delete(wsId)
        else streamsPerWs.set(wsId, n)
    })
})
