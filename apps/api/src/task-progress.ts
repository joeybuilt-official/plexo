// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, desc } from '@plexo/db'
import { taskSteps } from '@plexo/db'
import { logger } from './logger.js'
import { describeToolCall } from './utils/tool-labels.js'

/** Send the first update after this delay (ms). */
const FIRST_UPDATE_MS = 30_000
/** Subsequent update interval (ms). */
const INTERVAL_MS = 60_000

interface ToolCall {
    tool: string
    input?: Record<string, unknown>
    output?: string
}

interface StepRow {
    stepNumber: number
    toolCalls: unknown
    outcome: string | null
    createdAt: Date
}

function formatProgress(steps: StepRow[], totalSteps: number): string {
    if (steps.length === 0) return '🔄 Working on it…'

    const lastStep = steps[0]!
    const calls = lastStep.toolCalls as ToolCall[] | null ?? []
    const currentCall = calls[calls.length - 1]

    if (!currentCall) return `🔄 Working… (${totalSteps} steps done)`

    const action = describeToolCall(currentCall.tool, currentCall.input)
    return `🔄 ${action} (step ${totalSteps})`
}

export function startProgressReporter(
    taskId: string,
    send: (msg: string) => Promise<void>,
): () => void {
    let stopped = false

    async function sendUpdate() {
        if (stopped) return
        try {
            const steps = await db
                .select({
                    stepNumber: taskSteps.stepNumber,
                    toolCalls: taskSteps.toolCalls,
                    outcome: taskSteps.outcome,
                    createdAt: taskSteps.createdAt,
                })
                .from(taskSteps)
                .where(eq(taskSteps.taskId, taskId))
                .orderBy(desc(taskSteps.stepNumber))
                .limit(20)

            if (stopped) return
            const msg = formatProgress(steps, steps.length)
            await send(msg)
        } catch (err) {
            logger.warn({ err, taskId }, 'task-progress: failed to fetch steps')
        }
    }

    const firstTimer = setTimeout(() => {
        void sendUpdate()
        const interval = setInterval(() => {
            void sendUpdate()
        }, INTERVAL_MS)
        ;(stop as unknown as { _interval: ReturnType<typeof setInterval> })._interval = interval
    }, FIRST_UPDATE_MS)

    function stop() {
        stopped = true
        clearTimeout(firstTimer)
        const interval = (stop as unknown as { _interval?: ReturnType<typeof setInterval> })._interval
        if (interval) clearInterval(interval)
    }

    return stop
}
