// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
    recordAuthFailure,
    recordAuthSuccess,
    getAuthBadgeState,
    extractStatusCode,
    _resetAuthEventsForTest,
} from '../auth-events.js'

describe('router-v2 auth-events', () => {
    beforeEach(() => {
        _resetAuthEventsForTest()
    })

    it('extractStatusCode parses common provider error shapes', () => {
        expect(extractStatusCode('401 unauthorized: invalid api key')).toBe(401)
        expect(extractStatusCode('Request failed with status code 403')).toBe(403)
        expect(extractStatusCode('500 Internal Server Error')).toBe(500)
        expect(extractStatusCode('invalid api key — no status here')).toBeUndefined()
    })

    it('initial state: no failures → shouldShowBadge=false', () => {
        const s = getAuthBadgeState('ws-1', 'anthropic')
        expect(s.consecutiveFailures).toBe(0)
        expect(s.shouldShowBadge).toBe(false)
        expect(s.lastSuccessAt).toBe(0)
    })

    it('single failure does not raise badge', () => {
        recordAuthFailure({ workspaceId: 'ws-1', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', errorMessage: '401 unauthorized' })
        const s = getAuthBadgeState('ws-1', 'anthropic')
        expect(s.consecutiveFailures).toBe(1)
        expect(s.lastStatusCode).toBe(401)
        expect(s.shouldShowBadge).toBe(false)
    })

    it('3 consecutive failures within 24h → shouldShowBadge=true', () => {
        for (let i = 0; i < 3; i++) {
            recordAuthFailure({ workspaceId: 'ws-1', providerId: 'openai', modelId: 'gpt-4o', errorMessage: '403 forbidden' })
        }
        const s = getAuthBadgeState('ws-1', 'openai')
        expect(s.consecutiveFailures).toBe(3)
        expect(s.lastStatusCode).toBe(403)
        expect(s.shouldShowBadge).toBe(true)
    })

    it('success resets the streak and stamps lastSuccessAt', () => {
        for (let i = 0; i < 3; i++) {
            recordAuthFailure({ workspaceId: 'ws-1', providerId: 'openai', modelId: 'gpt-4o', errorMessage: '403 forbidden' })
        }
        expect(getAuthBadgeState('ws-1', 'openai').shouldShowBadge).toBe(true)
        recordAuthSuccess({ workspaceId: 'ws-1', providerId: 'openai' })
        const s = getAuthBadgeState('ws-1', 'openai')
        expect(s.consecutiveFailures).toBe(0)
        expect(s.shouldShowBadge).toBe(false)
        expect(s.lastSuccessAt).toBeGreaterThan(0)
    })

    it('stale streak (older than 24h) → shouldShowBadge=false even with 3 fails', () => {
        const realNow = Date.now
        try {
            // Anchor "now" 48h in the past for the first 3 failures.
            const t0 = 1_700_000_000_000
            const realDate = Date.now
            Date.now = vi.fn(() => t0)
            for (let i = 0; i < 3; i++) {
                recordAuthFailure({ workspaceId: 'ws-1', providerId: 'groq', modelId: 'llama-3.3-70b', errorMessage: '401 invalid_api_key' })
            }
            // Fast-forward 48h.
            Date.now = vi.fn(() => t0 + 48 * 60 * 60 * 1000)
            const s = getAuthBadgeState('ws-1', 'groq')
            expect(s.consecutiveFailures).toBe(3) // stored streak unchanged
            expect(s.shouldShowBadge).toBe(false) // but stale → no badge
            // After the freeze releases, restore.
            Date.now = realDate
        } finally {
            Date.now = realNow
        }
    })

    it('failure outside 24h window resets the running streak before incrementing', () => {
        const realNow = Date.now
        try {
            const t0 = 1_700_000_000_000
            Date.now = vi.fn(() => t0)
            recordAuthFailure({ workspaceId: 'ws-2', providerId: 'deepseek', modelId: 'deepseek-v3', errorMessage: '401 unauthorized' })
            recordAuthFailure({ workspaceId: 'ws-2', providerId: 'deepseek', modelId: 'deepseek-v3', errorMessage: '401 unauthorized' })
            // Jump >24h; next failure should reset the streak to 1.
            Date.now = vi.fn(() => t0 + 25 * 60 * 60 * 1000)
            recordAuthFailure({ workspaceId: 'ws-2', providerId: 'deepseek', modelId: 'deepseek-v3', errorMessage: '401 unauthorized' })
            const s = getAuthBadgeState('ws-2', 'deepseek')
            expect(s.consecutiveFailures).toBe(1)
            expect(s.shouldShowBadge).toBe(false)
        } finally {
            Date.now = realNow
        }
    })

    it('isolation: failures on (ws-1, anthropic) do not leak to (ws-2, anthropic)', () => {
        for (let i = 0; i < 3; i++) {
            recordAuthFailure({ workspaceId: 'ws-1', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', errorMessage: '401 unauthorized' })
        }
        expect(getAuthBadgeState('ws-1', 'anthropic').shouldShowBadge).toBe(true)
        expect(getAuthBadgeState('ws-2', 'anthropic').shouldShowBadge).toBe(false)
        expect(getAuthBadgeState('ws-2', 'anthropic').consecutiveFailures).toBe(0)
    })
})
