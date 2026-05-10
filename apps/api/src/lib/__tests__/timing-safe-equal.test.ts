// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { timingSafeStringEqual } from '../timing-safe-equal.js'

describe('timingSafeStringEqual (L2.5 telegram secret comparison)', () => {
    it('returns true for equal strings', () => {
        expect(timingSafeStringEqual('hello-world', 'hello-world')).toBe(true)
        expect(timingSafeStringEqual('', '')).toBe(true)
    })

    it('returns false for unequal strings of same length', () => {
        expect(timingSafeStringEqual('aaaaaa', 'bbbbbb')).toBe(false)
        expect(timingSafeStringEqual('abc123', 'abc124')).toBe(false)
    })

    it('returns false for length mismatch (without throwing)', () => {
        expect(timingSafeStringEqual('short', 'longer-string')).toBe(false)
        expect(timingSafeStringEqual('', 'nonempty')).toBe(false)
        expect(timingSafeStringEqual('nonempty', '')).toBe(false)
    })

    it('handles UTF-8 strings correctly (byte-level compare)', () => {
        expect(timingSafeStringEqual('café', 'café')).toBe(true)
        expect(timingSafeStringEqual('café', 'cafe')).toBe(false)
    })

    it('rejects partial-prefix matches (constant-time guarantee)', () => {
        const secret = 'super-secret-webhook-token'
        expect(timingSafeStringEqual(secret.slice(0, 5), secret)).toBe(false)
        expect(timingSafeStringEqual(secret + 'x', secret)).toBe(false)
    })
})
