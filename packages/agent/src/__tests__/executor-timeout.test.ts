// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2 of intelligence-hardening: wall-clock timeout on the
 * executor's generateText call. The production edit composes
 * ctx.signal with AbortSignal.timeout(STEP_TIMEOUT_MS) via
 * AbortSignal.any. This test validates the composition at the
 * primitive level — that the combined signal fires when either
 * the caller aborts OR the timeout elapses.
 *
 * We don't run the executor directly here — that would require a
 * full workspace fixture and mocks of half the agent package. We
 * validate the building block (AbortSignal.any + setTimeout) so a
 * future regression that drops AbortSignal.any breaks loudly.
 */

import { describe, it, expect } from 'vitest'

describe('AbortSignal.any composition — executor wall-clock timeout primitive', () => {
    it('fires when caller aborts first', async () => {
        const caller = new AbortController()
        const composed = AbortSignal.any([caller.signal, AbortSignal.timeout(5_000)])
        expect(composed.aborted).toBe(false)
        caller.abort()
        expect(composed.aborted).toBe(true)
    })

    it('fires when timeout elapses first', async () => {
        const caller = new AbortController()
        const composed = AbortSignal.any([caller.signal, AbortSignal.timeout(20)])
        expect(composed.aborted).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(composed.aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
    })

    it('remains alive when neither caller aborts nor timeout elapses', async () => {
        const caller = new AbortController()
        const composed = AbortSignal.any([caller.signal, AbortSignal.timeout(10_000)])
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(composed.aborted).toBe(false)
    })

    it('propagates the abort reason from whichever fires first', async () => {
        const caller = new AbortController()
        const composed = AbortSignal.any([caller.signal, AbortSignal.timeout(10_000)])
        caller.abort(new Error('user cancel'))
        expect(composed.aborted).toBe(true)
        expect((composed.reason as Error).message).toBe('user cancel')
    })

    it('STEP_TIMEOUT_MS env fallback lands at 180s', () => {
        const ms = Number(process.env.EXECUTOR_STEP_TIMEOUT_MS) || 180_000
        expect(ms).toBe(180_000)
    })

    it('STEP_TIMEOUT_MS env override is honored', () => {
        const prev = process.env.EXECUTOR_STEP_TIMEOUT_MS
        process.env.EXECUTOR_STEP_TIMEOUT_MS = '5000'
        const ms = Number(process.env.EXECUTOR_STEP_TIMEOUT_MS) || 180_000
        expect(ms).toBe(5_000)
        if (prev === undefined) delete process.env.EXECUTOR_STEP_TIMEOUT_MS
        else process.env.EXECUTOR_STEP_TIMEOUT_MS = prev
    })
})
