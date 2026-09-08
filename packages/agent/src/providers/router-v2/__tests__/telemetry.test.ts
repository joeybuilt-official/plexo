// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — routing telemetry through `RoutingEventStore`.
 *
 * Before the port this module could not be exercised without a live Postgres,
 * so the persisted shape had no coverage. These pin what the port must
 * preserve:
 *   1. the event → row mapping, including every `?? null` and the rounding
 *   2. a blocked selection persists null provider/model rather than dropping
 *      the row
 *   3. a rejecting store never breaks routing (telemetry is fire-and-forget)
 *   4. a throwing metrics hook never breaks routing either
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    buildRoutedEvent,
    emitRoutedEvent,
    setRoutingEventStore,
    setRoutedEventMetricsHook,
} from '../telemetry.js'
import type { RoutingEventStore, RoutingEventRecord } from '../../../routing-events.ports.js'
import type { SelectionResult } from '../selector.js'

class FakeRoutingEventStore implements RoutingEventStore {
    readonly rows: RoutingEventRecord[] = []
    rejectWith: Error | null = null

    async append(event: RoutingEventRecord): Promise<void> {
        if (this.rejectWith) throw this.rejectWith
        this.rows.push(event)
    }
}

function selection(over: Partial<SelectionResult> = {}): SelectionResult {
    return {
        chosen: { provider: 'anthropic', model: 'claude-haiku-4-5' } as SelectionResult['chosen'],
        alternatives: [],
        rationale: 'top score',
        manifestVersion: '1',
        requireOperatorAction: false,
        noManifestMatch: false,
        ...over,
    } as SelectionResult
}

let store: FakeRoutingEventStore

/** The persist call is deliberately fire-and-forget; let its microtask land. */
const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
    store = new FakeRoutingEventStore()
    setRoutingEventStore(store)
    setRoutedEventMetricsHook(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('emitRoutedEvent persistence', () => {
    it('maps the routed event onto one row, rounding the selector duration', async () => {
        emitRoutedEvent(buildRoutedEvent({
            workspaceId: 'ws-1',
            taskId: 'task-9',
            taskType: 'conversation',
            selection: selection({ modelRouted: true }),
            selectorDurationMs: 12.6,
            fallbackEngaged: false,
        }))
        await flush()

        expect(store.rows).toHaveLength(1)
        expect(store.rows[0]).toEqual({
            workspaceId: 'ws-1',
            taskId: 'task-9',
            taskType: 'conversation',
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            fallbackEngaged: false,
            selectorDurationMs: 13,
            shadowModelChoice: null,
            modelRouted: true,
        })
    })

    it('persists nulls for an absent workspace, task and selection', async () => {
        emitRoutedEvent(buildRoutedEvent({
            workspaceId: undefined,
            taskType: 'planning',
            selection: selection({ chosen: null, requireOperatorAction: true }),
            selectorDurationMs: 4,
            fallbackEngaged: true,
        }))
        await flush()

        expect(store.rows[0]).toMatchObject({
            workspaceId: null,
            taskId: null,
            provider: null,
            model: null,
            fallbackEngaged: true,
            modelRouted: false,
        })
    })

    it('does not break routing when the store rejects', async () => {
        store.rejectWith = new Error('routing_events is down')

        expect(() => emitRoutedEvent(buildRoutedEvent({
            workspaceId: 'ws-1',
            taskType: 'conversation',
            selection: selection(),
            selectorDurationMs: 1,
            fallbackEngaged: false,
        }))).not.toThrow()
        await flush()

        expect(store.rows).toHaveLength(0)
    })

    it('does not break routing when the metrics hook throws', async () => {
        setRoutedEventMetricsHook(() => { throw new Error('prometheus exploded') })

        expect(() => emitRoutedEvent(buildRoutedEvent({
            workspaceId: 'ws-1',
            taskType: 'conversation',
            selection: selection(),
            selectorDurationMs: 1,
            fallbackEngaged: false,
        }))).not.toThrow()
        await flush()

        expect(store.rows).toHaveLength(1)
    })
})
