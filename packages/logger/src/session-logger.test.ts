// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR-0045 Phase 2 — SessionLogger unit tests against an in-memory fake
 * SessionLogStore (no DB, no drizzle). Verifies the constructor seam, that
 * log() forwards the assembled record, and that a store failure is swallowed.
 */

import { describe, it, expect, vi } from 'vitest'
import { SessionLogger } from './session-logger'
import type { SessionLogStore, SessionLogInsert } from './ports'

class FakeStore implements SessionLogStore {
    records: SessionLogInsert[] = []
    async append(record: SessionLogInsert): Promise<void> { this.records.push(record) }
}

describe('SessionLogger', () => {
    it('forwards the event plus sessionId/personaId to the store', async () => {
        const store = new FakeStore()
        const logger = new SessionLogger({ sessionId: 's1', personaId: 'p1', store })
        await logger.log({ workspaceId: 'ws' } as never)
        expect(store.records).toHaveLength(1)
        expect(store.records[0]).toMatchObject({ workspaceId: 'ws', sessionId: 's1', personaId: 'p1' })
    })

    it('generates a sessionId when none is provided', async () => {
        const store = new FakeStore()
        const logger = new SessionLogger({ store })
        await logger.log({ workspaceId: 'ws' } as never)
        expect(typeof store.records[0]!.sessionId).toBe('string')
        expect((store.records[0]!.sessionId as string).length).toBeGreaterThan(0)
    })

    it('swallows store write failures (never throws into the caller)', async () => {
        const store: SessionLogStore = { append: vi.fn(async () => { throw new Error('db down') }) }
        const logger = new SessionLogger({ sessionId: 's', store })
        await expect(logger.log({ workspaceId: 'ws' } as never)).resolves.toBeUndefined()
    })
})
