// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — telemetry sink.
 *
 * Emits each routing decision to `console.info` (ops/log shape, same as
 * `provider.fallback_engaged` elsewhere) AND, Round-5 Phase 3, persists it to
 * the `routing_events` table so the decision survives a deploy and can be
 * dashboarded. The DB write is fire-and-forget — it never blocks or fails the
 * routing call. `routing_events` is pruned by runDataRetention() (pre-mortem #3).
 *
 * Event schema is the one-way door called out in plan.md Phase 3.
 * `alternatives_considered` is ALWAYS emitted per operator decision C2.
 */

import { db, sql } from '@plexo/db'
import type { Alternative, SelectionResult } from './selector.js'
import type { TaskType } from '../registry.js'

export interface RoutedEvent {
    event: 'model.routed'
    workspaceId: string | undefined
    /** Present when the call originates from a task row (executor dispatch). */
    taskId?: string
    taskType: TaskType
    chosen: { provider: string; model: string } | null
    alternatives_considered: Alternative[]
    rationale: string
    manifestVersion: string
    selectorDurationMs: number
    fallbackEngaged: boolean
    requireOperatorAction: boolean
    /** Present when the selector routed to a sub-recommended provider (ADR §C6 Q2). */
    degradation_reason?: 'workspace_low_quality_only'
}

export function buildRoutedEvent(args: {
    workspaceId: string | undefined
    taskId?: string
    taskType: TaskType
    selection: SelectionResult
    selectorDurationMs: number
    fallbackEngaged: boolean
}): RoutedEvent {
    const { workspaceId, taskId, taskType, selection, selectorDurationMs, fallbackEngaged } = args
    return {
        event: 'model.routed',
        workspaceId,
        ...(taskId ? { taskId } : {}),
        taskType,
        chosen: selection.chosen
            ? { provider: selection.chosen.provider, model: selection.chosen.model }
            : null,
        alternatives_considered: selection.alternatives,
        rationale: selection.rationale,
        manifestVersion: selection.manifestVersion,
        selectorDurationMs,
        fallbackEngaged,
        requireOperatorAction: selection.requireOperatorAction,
        ...(selection.degradationReason ? { degradation_reason: selection.degradationReason } : {}),
    }
}

export function emitRoutedEvent(evt: RoutedEvent): void {
    console.info(JSON.stringify(evt))
    void persistRoutedEvent(evt)
}

async function persistRoutedEvent(evt: RoutedEvent): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO routing_events
                (workspace_id, task_id, task_type, provider, model, fallback_engaged, selector_duration_ms)
            VALUES (
                ${evt.workspaceId ?? null},
                ${evt.taskId ?? null},
                ${evt.taskType},
                ${evt.chosen?.provider ?? null},
                ${evt.chosen?.model ?? null},
                ${evt.fallbackEngaged},
                ${Math.round(evt.selectorDurationMs)}
            )
        `)
    } catch {
        // Telemetry must never break routing. Console line above already captured it.
    }
}
