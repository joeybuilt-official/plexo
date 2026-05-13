// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — telemetry stub.
 *
 * Phase 2 emits via `console.info` (same shape as `provider.fallback_engaged`
 * elsewhere in the codebase). Phase 5 wires the real sink + dashboards.
 *
 * Event schema is the one-way door called out in plan.md Phase 3.
 * `alternatives_considered` is ALWAYS emitted per operator decision C2.
 */

import type { Alternative, SelectionResult } from './selector.js'
import type { TaskType } from '../registry.js'

export interface RoutedEvent {
    event: 'model.routed'
    workspaceId: string | undefined
    taskType: TaskType
    chosen: { provider: string; model: string } | null
    alternatives_considered: Alternative[]
    rationale: string
    manifestVersion: string
    selectorDurationMs: number
    fallbackEngaged: boolean
    requireOperatorAction: boolean
}

export function buildRoutedEvent(args: {
    workspaceId: string | undefined
    taskType: TaskType
    selection: SelectionResult
    selectorDurationMs: number
    fallbackEngaged: boolean
}): RoutedEvent {
    const { workspaceId, taskType, selection, selectorDurationMs, fallbackEngaged } = args
    return {
        event: 'model.routed',
        workspaceId,
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
    }
}

export function emitRoutedEvent(evt: RoutedEvent): void {
    // TODO(Phase 5): replace with real telemetry sink (Helm / PostHog / OTel).
    console.info(JSON.stringify(evt))
}
