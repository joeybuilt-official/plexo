// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sprint activity logger.
 *
 * Writes structured log entries to sprint_logs table AND emits an SSE event
 * so the Control Room UI updates in real time.
 *
 * Designed for fire-and-forget — errors are caught and swallowed so a logging
 * failure never kills the runner.
 */
import pino from 'pino'
import { db } from '@plexo/db'
import { sprintLogs } from '@plexo/db'

const log = pino({ name: 'sprint-logger' })

export type SprintLogLevel = 'info' | 'warn' | 'error'

export type SprintLogEvent =
    | 'planning_start'
    | 'planning_complete'
    | 'wave_start'
    | 'wave_complete'
    | 'task_queued'
    | 'task_running'
    | 'task_complete'
    | 'task_failed'
    | 'task_timeout'
    | 'pr_created'
    | 'pr_failed'
    | 'conflict_detected'
    | 'budget_check'
    | 'budget_ceiling_hit'
    | 'sprint_complete'
    | 'sprint_failed'
    | 'sprint_cancelled'
    | 'branch_created'
    | 'branch_failed'
    | 'pr_skipped'

export interface SprintLogEntry {
    sprintId: string
    level?: SprintLogLevel
    event: SprintLogEvent
    message: string
    metadata?: Record<string, unknown>
}

// Optional SSE emitter — injected at startup to avoid circular deps
let _emitFn: ((workspaceId: string, event: Record<string, unknown>) => void) | null = null
let _workspaceMap = new Map<string, string>() // sprintId → workspaceId

/** Call once during API startup to wire SSE push */
export function initSprintLogger(
    emitFn: (workspaceId: string, event: Record<string, unknown>) => void,
): void {
    _emitFn = emitFn
}

/** Register workspaceId for a sprint so SSE push works */
export function registerSprintWorkspace(sprintId: string, workspaceId: string): void {
    _workspaceMap.set(sprintId, workspaceId)
}

/** Deregister when sprint is done */
export function unregisterSprintWorkspace(sprintId: string): void {
    _workspaceMap.delete(sprintId)
}

export async function logSprintEvent(entry: SprintLogEntry): Promise<void> {
    const { sprintId, level = 'info', event, message, metadata = {} } = entry

    try {
        await db.insert(sprintLogs).values({
            sprintId,
            level,
            event,
            message,
            metadata,
        })
    } catch (err) {
        log.warn({ err, sprintId, event }, 'Failed to write sprint log to DB')
    }

    // SSE push — non-fatal
    try {
        const workspaceId = _workspaceMap.get(sprintId)
        if (_emitFn && workspaceId) {
            _emitFn(workspaceId, {
                type: 'sprint_log',
                sprintId,
                level,
                event,
                message,
                metadata,
                timestamp: new Date().toISOString(),
            })
        }
    } catch {
        // SSE failure is non-fatal
    }
}
