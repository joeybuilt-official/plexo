// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 6 — first-run wizard flow tests.
 *
 * apps/web tests run under a node environment (no DOM), same as the
 * other web-side test files in this repo. We exercise the contract bits
 * that don't need a browser:
 *
 *   1. completeWizard() POSTs to /api/v1/intel-dashboard/:ws/wizard/complete
 *   2. completeWizard() throws on non-OK status so the wizard catch
 *      branch surfaces an error to the user instead of silently passing.
 *   3. The step ordering matches the spec (detect → done in order).
 *   4. The advancement helpers move forward/back without overflow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { completeWizard } from '../../../../../lib/intelligence-dashboard-client'

const STEP_ORDER = ['detect', 'embeddings', 'routing', 'scl', 'budget', 'done'] as const
type StepKey = typeof STEP_ORDER[number]

function next(step: StepKey): StepKey {
    const i = STEP_ORDER.indexOf(step)
    return i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1]! : step
}

function prev(step: StepKey): StepKey {
    const i = STEP_ORDER.indexOf(step)
    return i > 0 ? STEP_ORDER[i - 1]! : step
}

describe('Phase 6 — wizard step ordering', () => {
    it('walks detect → embeddings → routing → scl → budget → done', () => {
        const seen: StepKey[] = []
        let s: StepKey = 'detect'
        for (let i = 0; i < STEP_ORDER.length; i++) {
            seen.push(s)
            s = next(s)
        }
        expect(seen).toEqual(['detect', 'embeddings', 'routing', 'scl', 'budget', 'done'])
    })

    it('next() saturates at done', () => {
        expect(next('done')).toBe('done')
    })

    it('prev() saturates at detect', () => {
        expect(prev('detect')).toBe('detect')
    })

    it('prev(done) walks back through every step', () => {
        const seen: StepKey[] = []
        let s: StepKey = 'done'
        for (let i = 0; i < STEP_ORDER.length; i++) {
            seen.push(s)
            s = prev(s)
        }
        expect(seen).toEqual(['done', 'budget', 'scl', 'routing', 'embeddings', 'detect'])
    })
})

describe('Phase 6 — completeWizard fetcher', () => {
    const originalFetch = globalThis.fetch
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, firstRunPending: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        globalThis.fetch = fetchSpy as unknown as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('POSTs to the wizard complete endpoint with credentials', async () => {
        const res = await completeWizard('ws-1234')
        expect(res).toEqual({ ok: true, firstRunPending: false })
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url, init] = fetchSpy.mock.calls[0]!
        expect(url).toBe('/api/v1/intel-dashboard/ws-1234/wizard/complete')
        expect((init as RequestInit).method).toBe('POST')
        expect((init as RequestInit).credentials).toBe('include')
    })

    it('throws on non-OK so the wizard surfaces the error', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 500 }))
        await expect(completeWizard('ws-err')).rejects.toThrow(/HTTP 500/)
    })
})
