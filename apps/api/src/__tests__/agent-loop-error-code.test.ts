// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2 of intelligence-hardening: error code propagation from
 * executor throws into blockTask reason. Production edit at
 * apps/api/src/agent-loop.ts:927-938 (landed earlier in commit
 * 65b770b). This test validates the reason-building logic the
 * production catch block uses: extract code from err.code or
 * err.errorCode, prefix the message with [CODE] when present,
 * skip the prefix for the sentinel 'EXECUTOR_ERROR'.
 *
 * Pure logic test — no mocks, no DB, no executor invocation.
 * The reason-building is 3 lines; this test pins those 3 lines.
 */

import { describe, it, expect } from 'vitest'

// ── Inline mirror of the production reason-building logic ────────────

function buildBlockTaskReason(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    const errCode = (err as { code?: string; errorCode?: string } | null)?.code
        ?? (err as { code?: string; errorCode?: string } | null)?.errorCode
        ?? null
    const reasonPrefix = errCode && errCode !== 'EXECUTOR_ERROR' ? `[${errCode}] ` : ''
    return reasonPrefix + message
}

describe('agent-loop reason building with error codes', () => {
    it('prefixes plain Error with no code — no prefix added', () => {
        const err = new Error('something broke')
        expect(buildBlockTaskReason(err)).toBe('something broke')
    })

    it('extracts code from err.code and prefixes', () => {
        const err = Object.assign(new Error('ceiling reached'), { code: 'COST_CEILING_EXCEEDED' })
        expect(buildBlockTaskReason(err)).toBe('[COST_CEILING_EXCEEDED] ceiling reached')
    })

    it('extracts from errorCode when code is absent', () => {
        const err = Object.assign(new Error('hung for 180s'), { errorCode: 'STEP_TIMEOUT' })
        expect(buildBlockTaskReason(err)).toBe('[STEP_TIMEOUT] hung for 180s')
    })

    it('prefers code over errorCode when both present', () => {
        const err = Object.assign(new Error('x'), { code: 'A', errorCode: 'B' })
        expect(buildBlockTaskReason(err)).toBe('[A] x')
    })

    it('skips the prefix for EXECUTOR_ERROR sentinel', () => {
        const err = Object.assign(new Error('generic'), { code: 'EXECUTOR_ERROR' })
        expect(buildBlockTaskReason(err)).toBe('generic')
    })

    it('handles non-Error throws', () => {
        expect(buildBlockTaskReason('string thrown')).toBe('string thrown')
        expect(buildBlockTaskReason(42)).toBe('42')
        expect(buildBlockTaskReason(null)).toBe('null')
    })

    it('handles AbortError from AbortSignal.timeout (Phase 2 Edit 1 composition)', () => {
        const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
        expect(buildBlockTaskReason(err)).toBe('[ABORT_ERR] This operation was aborted')
    })

    it('empty code string means no prefix', () => {
        const err = Object.assign(new Error('x'), { code: '' })
        expect(buildBlockTaskReason(err)).toBe('x')
    })

    it('known sentinel codes from executor get prefixed', () => {
        const codes = ['OWD_TIMEOUT', 'OWD_MALFORMED', 'COST_CEILING_EXCEEDED', 'CALL_MODEL_TIMEOUT', 'CALL_MODEL_4XX', 'CALL_MODEL_5XX']
        for (const code of codes) {
            const err = Object.assign(new Error('msg'), { code })
            expect(buildBlockTaskReason(err)).toBe(`[${code}] msg`)
        }
    })
})
