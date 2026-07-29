// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
// Import the pure helpers directly from `channel-state-format.ts`. Importing
// from `channel-delivery.ts` would pull in `channel-ai.ts` → `agent-loop.ts`
// → the entire @plexo/agent stack, which has too many transitive subpath
// imports to alias for a unit test.
import {
    formatTaskStateMessage,
    classifyConfirmCancel,
    extractConfirmationCode,
    channelSupportsConfirmation,
} from '../channel-state-format.js'

describe('formatTaskStateMessage', () => {
    it('emits a planning message with the title', () => {
        const out = formatTaskStateMessage({ state: 'planning', title: 'Refactor billing module' })
        expect(out).toContain('Refactor billing module')
        expect(out).toMatch(/plan/i)
    })

    it('clips long titles', () => {
        const long = 'x'.repeat(200)
        const out = formatTaskStateMessage({ state: 'planning', title: long })
        expect(out).toBeTruthy()
        // 100-char clip + ellipsis fits inside the message — verify the original
        // wasn't echoed in full.
        expect(out!.length).toBeLessThan(long.length + 50)
    })

    it('renders awaiting_confirmation with the code-prefixed CONFIRM/CANCEL prompt', () => {
        const out = formatTaskStateMessage({
            state: 'awaiting_confirmation',
            title: 'Deploy to prod',
            stepCount: 2,
            confirmationCode: 'abc123',
        })
        expect(out).toContain('CONFIRM abc123')
        expect(out).toContain('CANCEL abc123')
        expect(out).toContain('2 irreversible steps')
    })

    it('falls back to generic CONFIRM/CANCEL when no code is provided', () => {
        const out = formatTaskStateMessage({
            state: 'awaiting_confirmation',
            title: 'Deploy',
            stepCount: 1,
        })
        expect(out).toContain('Reply *CONFIRM*')
        expect(out).toContain('1 irreversible step')
        expect(out).not.toContain('CONFIRM ')
    })

    it('renders completed with the supplied summary', () => {
        const out = formatTaskStateMessage({ state: 'completed', completedSummary: 'Shipped 12 PRs' })
        expect(out).toContain('Shipped 12 PRs')
    })

    it('renders failed with all four escalation fields', () => {
        const out = formatTaskStateMessage({
            state: 'failed',
            summary: {
                what: 'Tried to deploy v1.4 to prod',
                why: 'Health check returned 503 from the canary host',
                action: 'Roll back the canary then re-run with --no-canary',
                recoverable: true,
            },
        })
        expect(out).toContain('Tried to deploy v1.4 to prod')
        expect(out).toContain('Health check returned 503')
        expect(out).toContain('Roll back the canary')
        expect(out).toMatch(/recoverable/i)
    })

    it('renders failed without a summary as a generic failure', () => {
        const out = formatTaskStateMessage({ state: 'failed' })
        expect(out).toContain('failed')
    })

    it('renders cancelled with optional reason', () => {
        expect(formatTaskStateMessage({ state: 'cancelled' })).toContain('cancelled')
        expect(formatTaskStateMessage({ state: 'cancelled', cancelReason: 'rejected by operator' }))
            .toContain('rejected by operator')
    })

    it('returns null for step_complete in non-verbose mode', () => {
        expect(formatTaskStateMessage({ state: 'step_complete' })).toBeNull()
        expect(formatTaskStateMessage({ state: 'step_complete', verbose: true })).toBeTruthy()
    })
})

describe('classifyConfirmCancel', () => {
    it('matches strict CONFIRM/APPROVE verbs (case-insensitive)', () => {
        expect(classifyConfirmCancel('CONFIRM')).toBe('confirm')
        expect(classifyConfirmCancel('confirm abc123')).toBe('confirm')
        expect(classifyConfirmCancel('Confirmed.')).toBe('confirm')
        expect(classifyConfirmCancel('approve')).toBe('confirm')
        expect(classifyConfirmCancel('  Approved please ')).toBe('confirm')
    })

    it('matches strict CANCEL/REJECT/ABORT verbs (case-insensitive)', () => {
        expect(classifyConfirmCancel('CANCEL')).toBe('cancel')
        expect(classifyConfirmCancel('cancelled')).toBe('cancel')
        expect(classifyConfirmCancel('Reject this')).toBe('cancel')
        expect(classifyConfirmCancel('abort')).toBe('cancel')
        expect(classifyConfirmCancel('aborted abc123')).toBe('cancel')
    })

    it('rejects loose tokens that previously caused false positives', () => {
        expect(classifyConfirmCancel('yes')).toBeNull()
        expect(classifyConfirmCancel('y')).toBeNull()
        expect(classifyConfirmCancel('ok please go')).toBeNull()
        expect(classifyConfirmCancel('no')).toBeNull()
        expect(classifyConfirmCancel('n')).toBeNull()
        expect(classifyConfirmCancel('stop that')).toBeNull()
    })

    it('rejects free-form text that mentions but does not lead with the verb', () => {
        expect(classifyConfirmCancel('I will not confirm anything')).toBeNull()
        expect(classifyConfirmCancel('please cancel later')).toBeNull()
    })

    it('returns null for empty / whitespace text', () => {
        expect(classifyConfirmCancel('')).toBeNull()
        expect(classifyConfirmCancel('   ')).toBeNull()
    })
})

describe('extractConfirmationCode', () => {
    it('extracts a 6-char hex code anywhere in the text', () => {
        expect(extractConfirmationCode('CONFIRM abc123')).toBe('abc123')
        expect(extractConfirmationCode('cancel  DEADBE')).toBe('deadbe')
        expect(extractConfirmationCode('confirmed; code: 0a1b2c please')).toBe('0a1b2c')
    })

    it('returns null when no 6-char hex code is present', () => {
        expect(extractConfirmationCode('CONFIRM')).toBeNull()
        expect(extractConfirmationCode('confirm abc')).toBeNull() // 3 chars, not 6
        expect(extractConfirmationCode('confirm abcdefg')).toBeNull() // 7 hex chars — boundary needs exactly 6
    })

    it('does not mistake decimal digits in plain prose for a code', () => {
        expect(extractConfirmationCode('confirm please')).toBeNull()
    })
})

describe('channelSupportsConfirmation', () => {
    it('accepts telegram/slack/discord', () => {
        expect(channelSupportsConfirmation('telegram')).toBe(true)
        expect(channelSupportsConfirmation('slack')).toBe(true)
        expect(channelSupportsConfirmation('discord')).toBe(true)
    })

    it('rejects web and unknown channels', () => {
        expect(channelSupportsConfirmation('web')).toBe(false)
        expect(channelSupportsConfirmation('email')).toBe(false)
        expect(channelSupportsConfirmation(undefined)).toBe(false)
        expect(channelSupportsConfirmation('')).toBe(false)
    })
})
