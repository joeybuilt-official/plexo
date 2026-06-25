// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR-0045 Phase 2 — queue use-case unit tests against an in-memory fake
 * TaskRepository (no DB, no drizzle). Exercises the pure orchestration that
 * now lives in index.ts: the SEC-043 queue cap and the FUN-037 retry/backoff
 * + max-attempts decision.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { push, requeueForRetry, setTaskRepository } from './index.js'
import type { TaskRepository, NewTask, TaskRow, ListFilter, CompleteParams } from './ports.js'
import type { TaskStatus } from '@plexo/db'

class FakeTaskRepository implements TaskRepository {
    queued = 0
    inserted: NewTask[] = []
    attempt: number | null = 0
    failedWith: number | null = null
    requeuedTo: { attemptCount: number; retryAfter: Date } | null = null

    async countQueued(): Promise<number> { return this.queued }
    async insert(task: NewTask): Promise<void> { this.inserted.push(task) }
    async claimNext(): Promise<TaskRow | null> { return null }
    async complete(_id: string, _p: CompleteParams): Promise<void> {}
    async setOutcome(_id: string, _s: TaskStatus, _o: string): Promise<void> {}
    async cancel(): Promise<void> {}
    async list(_f: ListFilter): Promise<TaskRow[]> { return [] }
    async getAttemptCount(): Promise<number | null> { return this.attempt }
    async failAfterAttempts(_id: string, attempts: number): Promise<void> { this.failedWith = attempts }
    async requeue(_id: string, attemptCount: number, retryAfter: Date): Promise<void> {
        this.requeuedTo = { attemptCount, retryAfter }
    }
}

let fake: FakeTaskRepository

beforeEach(() => {
    fake = new FakeTaskRepository()
    setTaskRepository(fake)
})

describe('push() — SEC-043 queue cap', () => {
    it('inserts when under the 500 cap', async () => {
        fake.queued = 499
        const id = await push({ workspaceId: 'ws', type: 'chat' as never, source: 'api', context: {} })
        expect(id).toBeTruthy()
        expect(fake.inserted).toHaveLength(1)
        expect(fake.inserted[0]!.status).toBe('queued')
        expect(fake.inserted[0]!.priority).toBe(1)
    })

    it('throws at the cap without inserting', async () => {
        fake.queued = 500
        await expect(push({ workspaceId: 'ws', type: 'chat' as never, source: 'api', context: {} }))
            .rejects.toThrow('Queue limit reached')
        expect(fake.inserted).toHaveLength(0)
    })
})

describe('requeueForRetry() — FUN-037 backoff + max attempts', () => {
    it('returns max_attempts when the task is gone', async () => {
        fake.attempt = null
        expect(await requeueForRetry('t')).toBe('max_attempts')
    })

    it('requeues with exponential backoff (120s on first retry)', async () => {
        fake.attempt = 0
        const before = Date.now()
        const result = await requeueForRetry('t')
        expect(result).toBe('requeued')
        expect(fake.requeuedTo!.attemptCount).toBe(1)
        const deltaSec = (fake.requeuedTo!.retryAfter.getTime() - before) / 1000
        expect(deltaSec).toBeGreaterThanOrEqual(119)
        expect(deltaSec).toBeLessThanOrEqual(122)
    })

    it('fails permanently once attempts exceed maxAttempts', async () => {
        fake.attempt = 3 // next attempt = 4 > default max 3
        const result = await requeueForRetry('t')
        expect(result).toBe('max_attempts')
        expect(fake.failedWith).toBe(4)
        expect(fake.requeuedTo).toBeNull()
    })
})
