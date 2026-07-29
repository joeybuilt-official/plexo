// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * reflectOnTask — Phase 2 / Phase 6 listener.
 *
 * Subscribes to TOPICS.TASK_COMPLETED and TOPICS.TASK_FAILED. Formats a
 * synthetic "turn text" from the task outcome and routes it through the
 * existing semantic memory pipeline (`recordTaskMemory`). Failures are
 * captured the same way as completions so the memory layer can answer
 * "have we tried this before, and what happened?" for both branches.
 *
 * Single-ownership rule: the memory write for task outcomes lives here,
 * not at the call site that completes the task. agent-loop.ts publishes
 * the event and this listener is the only writer of `type='task'`
 * memory entries originating from a task lifecycle.
 *
 * Anti-bloat consolidation continues to live in memory/consolidation.ts
 * and subscribes to the same TASK_COMPLETED topic independently.
 */

import pino from 'pino'
import { recordTaskMemory } from '../memory/store.js'
import { eventBus, TOPICS } from '../plugins/event-bus.js'
import { loadSettingsFromInstances } from '../providers/settings-from-instances.js'
import type { TaskCompletedPayload, TaskFailedPayload } from './types.js'

const logger = pino({ name: 'task-reflect' })

function buildCompletedNotes(payload: TaskCompletedPayload): string | undefined {
    const lines: string[] = []
    if (payload.outcomeSummary) lines.push(payload.outcomeSummary.slice(0, 800))
    if (typeof payload.durationMs === 'number') lines.push(`Duration: ${Math.round(payload.durationMs / 1000)}s`)
    return lines.length > 0 ? lines.join('\n') : undefined
}

function buildFailedNotes(payload: TaskFailedPayload): string {
    const s = payload.summary
    if (!s) return `Failure: ${payload.failureReason}`
    return [
        `Failure (${payload.failureReason}): ${s.what}`,
        `Why: ${s.why}`,
        `Action: ${s.action}`,
        `Recoverable: ${s.recoverable ? 'yes' : 'no'}`,
    ].join('\n')
}

async function reflectCompleted(payload: TaskCompletedPayload): Promise<void> {
    if (!payload.workspaceId || !payload.taskId) return
    const aiSettings = await loadSettingsFromInstances(payload.workspaceId).catch(() => null)
    await recordTaskMemory({
        workspaceId: payload.workspaceId,
        taskId: payload.taskId,
        description: payload.description,
        outcome: payload.outcome,
        toolsUsed: payload.toolsUsed ?? [],
        qualityScore: payload.qualityScore,
        durationMs: payload.durationMs,
        notes: buildCompletedNotes(payload),
        aiSettings: aiSettings ?? undefined,
    })
}

async function reflectFailed(payload: TaskFailedPayload): Promise<void> {
    if (!payload.workspaceId || !payload.taskId) return
    // Failures don't carry the task description in the event payload — fall
    // back to the failure-summary `what` field, which is the next best
    // user-meaningful framing of "what was this task trying to do?"
    const description = payload.summary?.what ?? `Task ${payload.taskId} (${payload.failureReason})`
    const aiSettings = await loadSettingsFromInstances(payload.workspaceId).catch(() => null)
    await recordTaskMemory({
        workspaceId: payload.workspaceId,
        taskId: payload.taskId,
        description,
        outcome: 'failure',
        toolsUsed: [],
        notes: buildFailedNotes(payload),
        aiSettings: aiSettings ?? undefined,
    })
}

let _initialized = false

/**
 * Wire the listener once at process startup. Idempotent — subsequent calls
 * are no-ops so re-imports during HMR or tests don't double-subscribe.
 */
export function initReflectListener(): void {
    if (_initialized) return
    _initialized = true

    eventBus.subscribe(TOPICS.TASK_COMPLETED, async (payload: unknown) => {
        try {
            await reflectCompleted(payload as TaskCompletedPayload)
        } catch (err) {
            logger.warn({ err }, 'reflectOnTask (completed) failed — non-fatal')
        }
    })

    eventBus.subscribe(TOPICS.TASK_FAILED, async (payload: unknown) => {
        try {
            await reflectFailed(payload as TaskFailedPayload)
        } catch (err) {
            logger.warn({ err }, 'reflectOnTask (failed) failed — non-fatal')
        }
    })

    logger.info('reflectOnTask listener registered on TASK_COMPLETED and TASK_FAILED')
}
