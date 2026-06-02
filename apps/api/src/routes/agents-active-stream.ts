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
import { db, eq, and, inArray, desc } from '@plexo/db'
import { taskSteps, tasks } from '@plexo/db'
import { logger } from '../logger.js'

export const agentsActiveStreamRouter: ExpressRouter = Router()

// In-flight, non-terminal statuses (task_status enum). Terminal = complete/
// completed/failed/cancelled; those drop out of the feed.
export const ACTIVE_STATUSES = ['queued', 'claimed', 'running'] as const

const STEP_SUMMARY_MAX = 160

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

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    let closed = false

    async function poll() {
        if (closed) return
        try {
            const active = await db
                .select({
                    id: tasks.id,
                    role: tasks.type,
                    status: tasks.status,
                    parentId: tasks.parentId,
                    outcomeSummary: tasks.outcomeSummary,
                })
                .from(tasks)
                .where(and(eq(tasks.workspaceId, wsId), inArray(tasks.status, [...ACTIVE_STATUSES])))
                .orderBy(tasks.createdAt)

            const latestByTask = new Map<string, LatestStep>()
            if (active.length > 0) {
                const ids = active.map((t) => t.id)
                const steps = await db
                    .select({
                        taskId: taskSteps.taskId,
                        stepNumber: taskSteps.stepNumber,
                        stepType: taskSteps.stepType,
                        state: taskSteps.state,
                        outcome: taskSteps.outcome,
                        error: taskSteps.error,
                    })
                    .from(taskSteps)
                    .where(inArray(taskSteps.taskId, ids))
                    .orderBy(taskSteps.taskId, desc(taskSteps.stepNumber))
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
        } catch (err) {
            logger.error({ err, workspaceId: wsId }, 'agents-active-stream poll error')
            if (!closed) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal poll error' })}\n\n`)
            }
        }
    }

    await poll()

    const pollTimer = setInterval(poll, 2000)
    const pingTimer = setInterval(() => {
        if (!closed) res.write(': ping\n\n')
    }, 15000)

    req.on('close', () => {
        closed = true
        clearInterval(pollTimer)
        clearInterval(pingTimer)
    })
})
