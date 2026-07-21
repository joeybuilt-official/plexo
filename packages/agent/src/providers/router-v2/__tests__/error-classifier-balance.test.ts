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

    it('does NOT flag groq\'s REAL full TPD message (upsell URL contains "billing")', () => {
        // Verbatim production message — the truncated fixture above passed while
        // production misfired on the /settings/billing URL in the upsell tail.
        const groqTpd = new Error(
            '429 Rate limit reached for model `llama-3.3-70b-versatile` in organization ' +
            '`org_01kjh7p9n8f1qs6nz2bz77vy6b` service tier `on_demand` on tokens per day (TPD): ' +
            'Limit 100000, Used 97050, Requested 3619. Please try again in 9m38.016s. ' +
            'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
        )
        expect(isBalanceExhaustedError(groqTpd)).toBe(false)
        // And it classifies as rate-limit (not quota) so it only gets a cooldown.
        expect(classifyError(groqTpd).class).toBe('rate-limit')
    })

    it('does NOT flag numbers that merely contain 402 (word-boundary match)', () => {
        expect(isBalanceExhaustedError(new Error('upstream error: request id 84025, tokens used 140250'))).toBe(false)
        expect(isBalanceExhaustedError(new Error('Request failed with status 402'))).toBe(true)
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
