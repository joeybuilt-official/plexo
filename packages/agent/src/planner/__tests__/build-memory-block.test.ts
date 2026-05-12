// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 6 — buildMemoryBlock unit tests.
 *
 * Exercises the memory-injection path without standing up a vector-enabled DB:
 * mocks `queryMemory` and asserts the rendered block, the empty-result path,
 * and the graceful-degradation path on retrieval failure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const queryMemory = vi.hoisted(() => vi.fn())
const emitMemoryInjection = vi.hoisted(() => vi.fn())

vi.mock('../../memory/query.js', () => ({ queryMemory }))
vi.mock('../../analytics/memory-events.js', () => ({ emitMemoryInjection }))

import { buildMemoryBlock } from '../index.js'
import type { WorkspaceAISettings } from '../../providers/registry.js'

const settings: WorkspaceAISettings = {
    providers: {},
    fallbackOrder: [],
} as unknown as WorkspaceAISettings

describe('buildMemoryBlock', () => {
    beforeEach(() => {
        queryMemory.mockReset()
        emitMemoryInjection.mockReset()
    })

    it('returns undefined when no memory hits', async () => {
        queryMemory.mockResolvedValue([])
        const out = await buildMemoryBlock('w1', 'u1', 'deploy the changelog hotfix', settings)
        expect(out).toBeUndefined()
    })

    it('renders shorthand-or-content lines under the header', async () => {
        queryMemory.mockResolvedValue([
            { id: '1', content: 'long content unused', shorthand: 'prefer pnpm over npm', metadata: {}, createdAt: new Date(), similarity: 0.9 },
            { id: '2', content: 'tests run via vitest', shorthand: '', metadata: {}, createdAt: new Date(), similarity: 0.85 },
        ])
        const out = await buildMemoryBlock('w1', 'u1', 'install deps', settings)
        expect(out).toMatch(/^RELEVANT PAST CONTEXT/)
        expect(out).toContain('- prefer pnpm over npm')
        expect(out).toContain('- tests run via vitest')
    })

    it('caps each fact at 240 chars with ellipsis', async () => {
        const long = 'x'.repeat(400)
        queryMemory.mockResolvedValue([{ id: '1', content: long, shorthand: '', metadata: {}, createdAt: new Date(), similarity: 0.9 }])
        const out = await buildMemoryBlock('w1', 'u1', 'something', settings)
        expect(out).toBeDefined()
        const factLine = out!.split('\n').find((l) => l.startsWith('- '))!
        expect(factLine.length).toBeLessThanOrEqual(2 + 240) // "- " prefix + cap
        expect(factLine.endsWith('…')).toBe(true)
    })

    it('returns undefined and does not throw when queryMemory rejects', async () => {
        queryMemory.mockRejectedValue(new Error('vector backend down'))
        const out = await buildMemoryBlock('w1', 'u1', 'anything', settings)
        expect(out).toBeUndefined()
    })

    it('passes workspaceId, userId, and queryText through to queryMemory', async () => {
        queryMemory.mockResolvedValue([])
        await buildMemoryBlock('ws-42', 'user-7', 'task description here', settings)
        expect(queryMemory).toHaveBeenCalledTimes(1)
        const arg = queryMemory.mock.calls[0]![0] as Record<string, unknown>
        expect(arg.workspaceId).toBe('ws-42')
        expect(arg.userId).toBe('user-7')
        expect(arg.queryText).toBe('task description here')
        expect(arg.limit).toBe(5)
    })

    it('emits memory.plan-injection on success with factsInjected count', async () => {
        queryMemory.mockResolvedValue([
            { id: '1', content: 'a', shorthand: '', metadata: {}, createdAt: new Date(), similarity: 0.9 },
            { id: '2', content: 'b', shorthand: '', metadata: {}, createdAt: new Date(), similarity: 0.85 },
        ])
        await buildMemoryBlock('ws-1', 'u-1', 'q', settings)
        expect(emitMemoryInjection).toHaveBeenCalledTimes(1)
        expect(emitMemoryInjection).toHaveBeenCalledWith({
            workspaceId: 'ws-1',
            userId: 'u-1',
            factsInjected: 2,
            retrievalFailed: false,
        })
    })

    it('emits memory.plan-injection with retrievalFailed=true on queryMemory rejection', async () => {
        queryMemory.mockRejectedValue(new Error('vector backend down'))
        await buildMemoryBlock('ws-2', 'u-2', 'q', settings)
        expect(emitMemoryInjection).toHaveBeenCalledTimes(1)
        expect(emitMemoryInjection).toHaveBeenCalledWith({
            workspaceId: 'ws-2',
            userId: 'u-2',
            factsInjected: 0,
            retrievalFailed: true,
        })
    })
})
