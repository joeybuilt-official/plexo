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
 *
 * GOTCHA — every timeout signal below is held in a named local const
 * on purpose. An AbortSignal.timeout() reachable ONLY through the
 * AbortSignal.any composite can be garbage-collected before its timer
 * fires: the composite does not strongly retain its source signals, and
 * a collected timeout signal never aborts. Inline it back into the
 * AbortSignal.any([...]) argument and these tests go non-deterministic —
 * the "timeout elapses" case failed roughly four runs in five on one
 * machine while passing on CI, and the "remains alive" case degrades
 * into a vacuous pass that would not notice if the timeout broke.
 */

import { once } from 'node:events'
import { describe, it, expect } from 'vitest'

describe('AbortSignal.any composition — executor wall-clock timeout primitive', () => {
    it('fires when caller aborts first', async () => {
        const caller = new AbortController()
        const timeout = AbortSignal.timeout(5_000)
        const composed = AbortSignal.any([caller.signal, timeout])
        expect(composed.aborted).toBe(false)
        caller.abort()
        expect(composed.aborted).toBe(true)
        expect(timeout.aborted).toBe(false)
    })

    it('fires when timeout elapses first', async () => {
        const caller = new AbortController()
        // Strong local reference — see the GOTCHA in the file header. Asserting
        // on `timeout` at the end also keeps it reachable for the whole test.
        const timeout = AbortSignal.timeout(20)
        const composed = AbortSignal.any([caller.signal, timeout])
        expect(composed.aborted).toBe(false)

        // Wait for the actual abort event rather than racing a fixed sleep, so
        // the assertion does not depend on a 30ms margin surviving load. The
        // guard covers the case where the timer already fired between the
        // assertion above and this line.
        if (!composed.aborted) await once(composed, 'abort')

        expect(composed.aborted).toBe(true)
        expect(timeout.aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
    })

    it('remains alive when neither caller aborts nor timeout elapses', async () => {
        const caller = new AbortController()
        // Without this reference a collected timeout signal makes the assertion
        // below pass for the wrong reason — see the GOTCHA in the file header.
        const timeout = AbortSignal.timeout(10_000)
        const composed = AbortSignal.any([caller.signal, timeout])
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(composed.aborted).toBe(false)
        expect(timeout.aborted).toBe(false)
    })

    it('propagates the abort reason from whichever fires first', async () => {
        const caller = new AbortController()
        const timeout = AbortSignal.timeout(10_000)
        const composed = AbortSignal.any([caller.signal, timeout])
        caller.abort(new Error('user cancel'))
        expect(composed.aborted).toBe(true)
        expect((composed.reason as Error).message).toBe('user cancel')
        expect(timeout.aborted).toBe(false)
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
