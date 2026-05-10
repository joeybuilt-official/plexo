// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../extract-worker.js', () => ({
    extractTurn: vi.fn().mockResolvedValue(undefined),
}))

// vitest cannot resolve workspace `@plexo/queue/inngest` from inside @plexo/agent
// without a tsconfig-paths plugin; mock the surface used by extract-turn-fn instead.
vi.mock('@plexo/queue/inngest', () => ({
    inngest: {
        createFunction: vi.fn().mockReturnValue({
            id: () => 'memory-extract-turn',
        }),
    },
}))

const { extractTurn } = await import('../../extract-worker.js')
const { extractTurnFromEvent, extractTurnFn } = await import('../extract-turn-fn.js')

const happyData = {
    workspaceId: 'ws-1',
    userMessage: 'I prefer TypeScript',
    assistantReply: 'Got it',
    sessionId: 'sess-1',
    source: 'unit-test',
}

describe('extractTurnFromEvent', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('forwards the event data to extractTurn and returns ok', async () => {
        const result = await extractTurnFromEvent(happyData)
        expect(result).toEqual({ ok: true })
        expect(extractTurn).toHaveBeenCalledWith(happyData)
        expect(extractTurn).toHaveBeenCalledTimes(1)
    })

    it('propagates extractTurn errors so Inngest retries → DLQ', async () => {
        vi.mocked(extractTurn).mockRejectedValueOnce(new Error('llm-down'))
        await expect(extractTurnFromEvent(happyData)).rejects.toThrow('llm-down')
    })
})

describe('extractTurnFn config', () => {
    it('is registered as an Inngest function with the expected id', () => {
        expect(extractTurnFn).toBeDefined()
        expect(typeof extractTurnFn.id).toBe('function')
        expect(extractTurnFn.id()).toContain('memory-extract-turn')
    })
})
