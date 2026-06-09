// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isBalanceExhaustedError, classifyError } from '../error-classifier.js'

describe('isBalanceExhaustedError (Fix A)', () => {
    it('flags DeepSeek funds depletion', () => {
        expect(isBalanceExhaustedError(new Error('AI_APICallError: Insufficient Balance'))).toBe(true)
    })

    it('flags genuine funds depletion: OpenAI billing, HTTP 402, Anthropic credit', () => {
        // OpenAI's real billing exhaustion carries "billing" in the message.
        expect(isBalanceExhaustedError(new Error('You exceeded your current quota, please check your plan and billing details'))).toBe(true)
        expect(isBalanceExhaustedError(new Error('Request failed with status 402'))).toBe(true)
        expect(isBalanceExhaustedError(new Error('Your credit balance is too low'))).toBe(true)
    })

    it('does NOT flag a rate-limit / daily-TPD cap (those reset on their own)', () => {
        // groq's TPD message classifies as rate-limit, not a durable balance state.
        expect(isBalanceExhaustedError(new Error('Rate limit reached for model gpt-oss-120b ... tokens per day (TPD): Limit 200000'))).toBe(false)
        expect(isBalanceExhaustedError(new Error('Too Many Requests'))).toBe(false)
        expect(isBalanceExhaustedError(new Error('429'))).toBe(false)
    })

    it('does NOT persist-pull on a bare insufficient_quota (ambiguous: OpenAI=funds but Groq=daily TPD reset)', () => {
        // The ambiguous token alone must not trigger a durable pull — a daily
        // quota cap recovers on its own. Genuine funds cases carry billing/402/
        // credit/balance language and are covered by the test above.
        expect(isBalanceExhaustedError(new Error('You exceeded your current quota: insufficient_quota'))).toBe(false)
        expect(isBalanceExhaustedError(new Error('insufficient quota'))).toBe(false)
    })

    it('does NOT flag non-Error inputs', () => {
        expect(isBalanceExhaustedError('Insufficient Balance')).toBe(false)
        expect(isBalanceExhaustedError(null)).toBe(false)
    })

    it('balance errors still classify as fallback-able quota (cascade advances)', () => {
        const c = classifyError(new Error('Insufficient Balance'))
        expect(c.class).toBe('quota')
        expect(c.shouldFallback).toBe(true)
    })
})
