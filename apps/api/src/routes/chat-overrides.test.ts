// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DD-5 tests: pure merge/resolution helpers for per-conversation model +
 * system-prompt overrides. Side-effect-free → no DB/provider mocking needed.
 */
import { describe, it, expect } from 'vitest'
import { resolveModelOverride, composeSystemPrompt } from './chat-overrides.js'

describe('resolveModelOverride', () => {
    it('returns the per-turn value when present', () => {
        expect(resolveModelOverride('openai/gpt-4o', 'anthropic/claude-sonnet-4-5')).toBe('openai/gpt-4o')
    })

    it('falls back to the persisted value when per-turn is null/empty', () => {
        expect(resolveModelOverride(null, 'anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5')
        expect(resolveModelOverride('', 'anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5')
        expect(resolveModelOverride(undefined, 'anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5')
    })

    it('returns undefined when neither source has a value', () => {
        expect(resolveModelOverride(null, null)).toBeUndefined()
        expect(resolveModelOverride(undefined, undefined)).toBeUndefined()
        expect(resolveModelOverride('', '')).toBeUndefined()
    })

    it('trims whitespace before deciding emptiness', () => {
        expect(resolveModelOverride('   ', 'openai/gpt-4o')).toBe('openai/gpt-4o')
        expect(resolveModelOverride('  openai/gpt-4o  ', null)).toBe('openai/gpt-4o')
    })

    it('passes through bare model ids (no provider prefix)', () => {
        expect(resolveModelOverride('gpt-4o', null)).toBe('gpt-4o')
    })
})

describe('composeSystemPrompt', () => {
    it('returns the compiled prompt unchanged when override is empty/null', () => {
        const compiled = 'You are Plexo.'
        expect(composeSystemPrompt(compiled, null)).toBe(compiled)
        expect(composeSystemPrompt(compiled, undefined)).toBe(compiled)
        expect(composeSystemPrompt(compiled, '')).toBe(compiled)
        expect(composeSystemPrompt(compiled, '   ')).toBe(compiled)
    })

    it('PREPENDS the override with a blank-line separator', () => {
        const compiled = 'You are Plexo.'
        const result = composeSystemPrompt(compiled, 'Be terse.')
        expect(result).toBe('Be terse.\n\nYou are Plexo.')
    })

    it('trims the override before prepending', () => {
        const compiled = 'You are Plexo.'
        expect(composeSystemPrompt(compiled, '  Be terse.  ')).toBe('Be terse.\n\nYou are Plexo.')
    })

    it('preserves multi-line compiled prompts and overrides', () => {
        const compiled = 'Line 1\nLine 2'
        const override = 'Override A\nOverride B'
        expect(composeSystemPrompt(compiled, override)).toBe('Override A\nOverride B\n\nLine 1\nLine 2')
    })
})