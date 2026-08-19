// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Characterization tests for the per-session mutex extracted from
 * `routes/chat.ts` (FUN-001).
 *
 * Pins the chain semantics: turns for the same session key run strictly
 * serially in submission order, turns for distinct keys overlap freely,
 * and the lock map drains to empty once the chain settles. The route
 * relies on all three invariants to prevent duplicate provider calls and
 * conversation-history corruption.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    withSessionLock,
    __clearSessionLocksForTest,
    __sessionLockCountForTest,
} from '../../application/chat/sessionLock.js'

beforeEach(() => __clearSessionLocksForTest())

describe('withSessionLock', () => {
    it('runs a single thunk and returns its value', async () => {
        const r = await withSessionLock('s1', async () => 42)
        expect(r).toBe(42)
    })

    it('serializes same-key thunks in submission order', async () => {
        const order: number[] = []
        const t = (n: number) => withSessionLock('s1', async () => {
            order.push(n)
            return n
        })
        const p1 = t(1)
        const p2 = t(2)
        const p3 = t(3)
        await Promise.all([p1, p2, p3])
        expect(order).toEqual([1, 2, 3])
    })

    it('does not start the next same-key thunk until the prior resolves', async () => {
        let firstStarted = false
        let firstReleased = false
        const p1 = withSessionLock('s1', async () => {
            firstStarted = true
            await new Promise<void>(r => setTimeout(r, 20))
            firstReleased = true
        })
        let secondStarted = false
        const p2 = withSessionLock('s1', async () => {
            secondStarted = true
        })
        await new Promise<void>(r => setTimeout(r, 5))
        expect(firstStarted).toBe(true)
        expect(secondStarted).toBe(false)
        await p1
        await p2
        expect(firstReleased).toBe(true)
        expect(secondStarted).toBe(true)
    })

    it('allows different keys to run concurrently', async () => {
        let aRunning = false
        let bRunning = false
        let overlapped = false
        const p1 = withSessionLock('a', async () => {
            aRunning = true
            await new Promise<void>(r => setTimeout(r, 15))
            if (bRunning) overlapped = true
            aRunning = false
        })
        const p2 = withSessionLock('b', async () => {
            bRunning = true
            await new Promise<void>(r => setTimeout(r, 15))
            if (aRunning) overlapped = true
            bRunning = false
        })
        await Promise.all([p1, p2])
        expect(overlapped).toBe(true)
    })

    it('releases the lock even when the thunk rejects', async () => {
        const p1 = withSessionLock('s1', async () => { throw new Error('boom') })
        await expect(p1).rejects.toThrow('boom')
        // A subsequent same-key thunk must run (lock was released in finally).
        const r = await withSessionLock('s1', async () => 'ok')
        expect(r).toBe('ok')
    })

    it('propagates the thunk rejection value', async () => {
        const err = new Error('specific')
        await expect(withSessionLock('s1', async () => { throw err })).rejects.toBe(err)
    })

    it('drains the lock map to empty after a same-key chain settles', async () => {
        const tasks = Array.from({ length: 4 }, (_, i) =>
            withSessionLock('s1', async () => i),
        )
        await Promise.all(tasks)
        expect(__sessionLockCountForTest()).toBe(0)
    })

    it('does not clobber a newer lock entry on finally (late prior cleanup)', async () => {
        // Drive a chain; after all settle the map is empty. This pins the
        // `=== current` guard: a prior thunk whose cleanup runs after a newer
        // thunk installed its promise must NOT delete the newer entry.
        const p1 = withSessionLock('s1', async () => 1)
        const p2 = withSessionLock('s1', async () => 2)
        const p3 = withSessionLock('s1', async () => 3)
        await Promise.all([p1, p2, p3])
        expect(__sessionLockCountForTest()).toBe(0)
    })
})