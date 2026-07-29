// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('handshakeRateLimit', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        // Clear module cache so each test gets a fresh store
        vi.resetModules()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('allows up to 10 requests per IP within 60 seconds', async () => {
        const { handshakeRateLimit } = await import('./rate-limit')
        for (let i = 0; i < 10; i++) {
            expect(handshakeRateLimit('1.2.3.4')).toBe(true)
        }
        expect(handshakeRateLimit('1.2.3.4')).toBe(false)
    })

    it('resets after the 60-second window', async () => {
        const { handshakeRateLimit } = await import('./rate-limit')
        for (let i = 0; i < 10; i++) {
            handshakeRateLimit('5.6.7.8')
        }
        expect(handshakeRateLimit('5.6.7.8')).toBe(false)

        // Advance past the window
        vi.advanceTimersByTime(61_000)
        expect(handshakeRateLimit('5.6.7.8')).toBe(true)
    })

    it('tracks IPs independently', async () => {
        const { handshakeRateLimit } = await import('./rate-limit')
        for (let i = 0; i < 10; i++) {
            handshakeRateLimit('10.0.0.1')
        }
        expect(handshakeRateLimit('10.0.0.1')).toBe(false)
        // Different IP should still be allowed
        expect(handshakeRateLimit('10.0.0.2')).toBe(true)
    })
})
