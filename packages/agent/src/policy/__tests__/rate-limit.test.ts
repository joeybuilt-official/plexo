// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { RateLimiter, DEFAULT_RATE_LIMIT } from '../rate-limit.js'
import { setPolicySignalEmitter, type PolicySignal } from '../signals.js'
import type { PolicyCaller } from '../types.js'

const PLEXO: PolicyCaller = { workspaceId: '00000000-0000-0000-0000-00000000aaaa', appId: 'plexo' }
const LEVIO: PolicyCaller = { workspaceId: PLEXO.workspaceId, appId: 'levio' }

describe('RateLimiter', () => {
    let signals: PolicySignal[]
    beforeEach(() => {
        signals = []
        setPolicySignalEmitter((s) => signals.push(s))
    })

    it('starts each (workspace, app) pair at a full burst', () => {
        const rl = new RateLimiter()
        const d = rl.consume(PLEXO, 1, 0)
        expect(d.allowed).toBe(true)
        expect(d.remaining).toBe(99)
    })

    it('throttles after burst is exhausted and emits one signal', () => {
        const rl = new RateLimiter()
        for (let i = 0; i < DEFAULT_RATE_LIMIT.burst; i++) {
            expect(rl.consume(PLEXO, 1, 0).allowed).toBe(true)
        }
        const denied = rl.consume(PLEXO, 1, 0)
        expect(denied.allowed).toBe(false)
        expect(denied.retryAfterMs).toBeGreaterThan(0)
        expect(signals.find((s) => s.kind === 'rate_limit_throttled')).toBeDefined()
    })

    it('refills at 100/min — at +6s about 10 tokens have refilled', () => {
        const rl = new RateLimiter()
        // Burn the bucket
        for (let i = 0; i < 100; i++) rl.consume(PLEXO, 1, 0)
        // 6 seconds later — refill should put ~10 back
        const d = rl.consume(PLEXO, 5, 6_000)
        expect(d.allowed).toBe(true)
        expect(d.remaining).toBeGreaterThanOrEqual(4)
        expect(d.remaining).toBeLessThanOrEqual(5)
    })

    it('separates buckets per (workspace, app) pair', () => {
        const rl = new RateLimiter()
        for (let i = 0; i < 100; i++) rl.consume(PLEXO, 1, 0)
        const otherApp = rl.consume(LEVIO, 1, 0)
        expect(otherApp.allowed).toBe(true)
    })

    it('honors per-app override (200/200) — burst doubles', () => {
        const rl = new RateLimiter((_ws, app) => (app === 'levio' ? { burst: 200, refillPerMin: 200 } : null))
        for (let i = 0; i < 200; i++) {
            expect(rl.consume(LEVIO, 1, 0).allowed).toBe(true)
        }
        expect(rl.consume(LEVIO, 1, 0).allowed).toBe(false)
        // plexo unaffected
        expect(rl.consume(PLEXO, 1, 0).allowed).toBe(true)
    })

    it('consumeBulkImport bypasses tokens and increments audit only', () => {
        const rl = new RateLimiter()
        for (let i = 0; i < 100; i++) rl.consume(PLEXO, 1, 0) // burn bucket exactly to 0
        signals.length = 0  // ignore any signals from the burn loop
        rl.consumeBulkImport(PLEXO, 5_000)
        expect(rl.getBulkImportAuditCount()).toBe(5_000)
        // Bulk import is a pure bypass — no throttle signal regardless of bucket state
        expect(signals.filter((s) => s.kind === 'rate_limit_throttled')).toHaveLength(0)
    })

    it('cost > 1 deducts proportionally', () => {
        const rl = new RateLimiter()
        const d = rl.consume(PLEXO, 25, 0)
        expect(d.allowed).toBe(true)
        expect(d.remaining).toBe(75)
    })

    it('cost greater than burst is rejected with retry hint', () => {
        const rl = new RateLimiter()
        const d = rl.consume(PLEXO, 200, 0)
        expect(d.allowed).toBe(false)
        expect(d.retryAfterMs).toBeGreaterThan(0)
    })
})
