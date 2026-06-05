// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
    laneFor,
    laneIsolationEnabled,
    withLane,
    Semaphore,
    _resetLaneLimiterForTest,
} from '../lane-limiter.js'
import type { TaskType } from '../../registry.js'

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
}

describe('router-v2 lane-limiter', () => {
    beforeEach(() => {
        delete process.env.PLEXO_AI_LANE_ISOLATION
        delete process.env.PLEXO_BG_AI_MAX_CONCURRENT
        _resetLaneLimiterForTest()
    })
    afterEach(() => {
        delete process.env.PLEXO_AI_LANE_ISOLATION
        delete process.env.PLEXO_BG_AI_MAX_CONCURRENT
        _resetLaneLimiterForTest()
    })

    describe('laneFor', () => {
        it('classifies fire-and-forget callers as background', () => {
            for (const t of ['summarization', 'judging', 'logAnalysis'] as TaskType[]) {
                expect(laneFor(t)).toBe('background')
            }
        })
        it('classifies human/task-blocking callers as interactive', () => {
            for (const t of [
                'planning', 'codeGeneration', 'verification',
                'conversation', 'classification', 'extraction',
            ] as TaskType[]) {
                expect(laneFor(t)).toBe('interactive')
            }
        })
    })

    describe('laneIsolationEnabled', () => {
        it('is off unless flag === "1"', () => {
            expect(laneIsolationEnabled()).toBe(false)
            process.env.PLEXO_AI_LANE_ISOLATION = '0'
            expect(laneIsolationEnabled()).toBe(false)
            process.env.PLEXO_AI_LANE_ISOLATION = 'true'
            expect(laneIsolationEnabled()).toBe(false)
            process.env.PLEXO_AI_LANE_ISOLATION = '1'
            expect(laneIsolationEnabled()).toBe(true)
        })
    })

    describe('Semaphore', () => {
        it('caps concurrency and hands freed slots to waiters FIFO', async () => {
            const sem = new Semaphore(2)
            await sem.acquire()
            await sem.acquire()
            expect(sem.inFlightFree).toBe(0)

            let third = false
            const p = sem.acquire().then(() => { third = true })
            await Promise.resolve()
            expect(third).toBe(false)
            expect(sem.waiting).toBe(1)

            sem.release()
            await p
            expect(third).toBe(true)
        })

        it('release without a waiter restores a free slot', () => {
            const sem = new Semaphore(1)
            sem.release()
            expect(sem.inFlightFree).toBe(2)
        })
    })

    describe('withLane — flag OFF (default)', () => {
        it('runs background work with no concurrency limit', async () => {
            const gateA = deferred()
            const gateB = deferred()
            let aStarted = false
            let bStarted = false

            const a = withLane('summarization' as TaskType, async () => { aStarted = true; await gateA.promise })
            const b = withLane('summarization' as TaskType, async () => { bStarted = true; await gateB.promise })
            await Promise.resolve()

            // No cap when disabled → both run concurrently even at cap 1.
            expect(aStarted).toBe(true)
            expect(bStarted).toBe(true)
            gateA.resolve(); gateB.resolve()
            await Promise.all([a, b])
        })
    })

    describe('withLane — flag ON', () => {
        beforeEach(() => { process.env.PLEXO_AI_LANE_ISOLATION = '1' })

        it('background burst does NOT delay a concurrent interactive (planning) call', async () => {
            process.env.PLEXO_BG_AI_MAX_CONCURRENT = '1'
            _resetLaneLimiterForTest()

            const bgGate = deferred()
            let bg2Started = false
            let planningRan = false

            // Saturate the background lane (cap 1): bg1 holds the only permit.
            const bg1 = withLane('summarization' as TaskType, async () => { await bgGate.promise })
            await Promise.resolve()
            // bg2 must queue behind bg1.
            const bg2 = withLane('summarization' as TaskType, async () => { bg2Started = true })
            await Promise.resolve()
            expect(bg2Started).toBe(false)

            // Interactive planning runs immediately despite the saturated bg lane.
            await withLane('planning' as TaskType, async () => { planningRan = true })
            expect(planningRan).toBe(true)
            expect(bg2Started).toBe(false)

            // Drain.
            bgGate.resolve()
            await Promise.all([bg1, bg2])
            expect(bg2Started).toBe(true)
        })

        it('releases the permit on throw (no leak / deadlock)', async () => {
            process.env.PLEXO_BG_AI_MAX_CONCURRENT = '1'
            _resetLaneLimiterForTest()

            await expect(
                withLane('summarization' as TaskType, async () => { throw new Error('boom') }),
            ).rejects.toThrow('boom')

            // If the permit leaked, this second background call would hang forever.
            let ran = false
            await withLane('summarization' as TaskType, async () => { ran = true })
            expect(ran).toBe(true)
        })
    })
})
