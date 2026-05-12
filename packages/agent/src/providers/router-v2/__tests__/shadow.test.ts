// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — shadow harness unit tests.
 *
 * Verifies the shadow-compare runner:
 *   - emits a `model.routed.shadow_compare` event w/ the frozen schema
 *   - swallows shadow-path errors (never re-throws)
 *   - reports response_shape_match correctly across ok/ok, err/err, mixed
 *   - swallows emitter exceptions (defense in depth)
 */

import { describe, it, expect, vi } from 'vitest'
import {
    buildShadowCompareEvent,
    computeShapeMatch,
    extractShapeKeys,
    runShadowCompare,
    type ShadowCompareEvent,
    type ShadowPrimaryOutcome,
} from '../shadow.js'

const PRIMARY_OK: ShadowPrimaryOutcome = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 'ok',
    latencyMs: 42,
    resultKeys: ['attempts', 'inputTokens', 'latencyMs', 'model', 'outputTokens', 'text'],
}

describe('extractShapeKeys', () => {
    it('returns sorted top-level keys for plain objects', () => {
        expect(extractShapeKeys({ b: 1, a: 2 })).toEqual(['a', 'b'])
    })
    it('returns [] for non-objects', () => {
        expect(extractShapeKeys(null)).toEqual([])
        expect(extractShapeKeys(undefined)).toEqual([])
        expect(extractShapeKeys('hi')).toEqual([])
        expect(extractShapeKeys(42)).toEqual([])
    })
})

describe('computeShapeMatch', () => {
    it('matches when both ok with same sorted keys', () => {
        expect(computeShapeMatch(
            PRIMARY_OK,
            { provider: 'anthropic', model: 'claude-3-5-haiku', status: 'ok', latencyMs: 60, resultKeys: PRIMARY_OK.resultKeys },
        )).toBe(true)
    })
    it('does not match when ok results have different keys', () => {
        expect(computeShapeMatch(
            PRIMARY_OK,
            { provider: 'a', model: 'm', status: 'ok', latencyMs: 1, resultKeys: ['text'] },
        )).toBe(false)
    })
    it('matches when both error with same errorClass', () => {
        expect(computeShapeMatch(
            { ...PRIMARY_OK, status: 'error', errorClass: 'CALL_MODEL_TIMEOUT', resultKeys: undefined },
            { provider: 'b', model: 'm', status: 'error', latencyMs: 1, errorClass: 'CALL_MODEL_TIMEOUT' },
        )).toBe(true)
    })
    it('does not match mixed ok/error', () => {
        expect(computeShapeMatch(
            PRIMARY_OK,
            { provider: 'b', model: 'm', status: 'error', latencyMs: 1, errorClass: 'X' },
        )).toBe(false)
    })
})

describe('buildShadowCompareEvent', () => {
    it('produces the frozen schema fields exactly', () => {
        const evt = buildShadowCompareEvent({
            workspaceId: 'ws-1',
            taskType: 'summarization',
            primary: PRIMARY_OK,
            shadow: {
                provider: 'anthropic', model: 'claude-3-5-haiku', status: 'ok',
                latencyMs: 60, resultKeys: PRIMARY_OK.resultKeys,
            },
        })
        const expectedKeys: ReadonlyArray<keyof ShadowCompareEvent> = [
            'event', 'workspaceId', 'taskType',
            'primary_provider', 'primary_model', 'primary_status', 'primary_latency_ms', 'primary_error_class',
            'shadow_provider', 'shadow_model', 'shadow_status', 'shadow_latency_ms', 'shadow_error_class',
            'response_shape_match',
        ]
        for (const k of expectedKeys) expect(evt).toHaveProperty(k)
        expect(evt.event).toBe('model.routed.shadow_compare')
        expect(evt.response_shape_match).toBe(true)
        expect(evt.primary_provider).toBe('openai')
        expect(evt.shadow_provider).toBe('anthropic')
    })

    it('records shadow=null as a shadow-internal-failure error event', () => {
        const evt = buildShadowCompareEvent({
            workspaceId: 'ws-1',
            taskType: 'summarization',
            primary: PRIMARY_OK,
            shadow: null,
        })
        expect(evt.shadow_status).toBe('error')
        expect(evt.shadow_error_class).toBe('shadow-internal-failure')
        expect(evt.response_shape_match).toBe(false)
    })
})

describe('runShadowCompare', () => {
    it('emits a compare event on shadow success', async () => {
        const emitter = vi.fn()
        await runShadowCompare({
            workspaceId: 'ws-1',
            taskType: 'summarization',
            primary: PRIMARY_OK,
            runShadow: async () => ({
                text: 'hi', inputTokens: 1, outputTokens: 1, latencyMs: 5,
                model: 'claude-3-5-haiku', attempts: 1,
            }),
            extractRouted: (r) => ({ provider: 'anthropic', model: (r as { model: string }).model }),
            emitter,
        })
        expect(emitter).toHaveBeenCalledTimes(1)
        const evt = emitter.mock.calls[0]![0] as ShadowCompareEvent
        expect(evt.event).toBe('model.routed.shadow_compare')
        expect(evt.shadow_provider).toBe('anthropic')
        expect(evt.shadow_status).toBe('ok')
        expect(evt.response_shape_match).toBe(true)
    })

    it('swallows shadow path errors and emits an error-shaped event', async () => {
        const emitter = vi.fn()
        // Must not throw out of runShadowCompare.
        await expect(runShadowCompare({
            workspaceId: 'ws-1',
            taskType: 'summarization',
            primary: PRIMARY_OK,
            runShadow: async () => { throw new Error('shadow boom') },
            emitter,
        })).resolves.toBeUndefined()
        expect(emitter).toHaveBeenCalledTimes(1)
        const evt = emitter.mock.calls[0]![0] as ShadowCompareEvent
        expect(evt.shadow_status).toBe('error')
        expect(evt.shadow_error_class).toBe('Error')
        expect(evt.response_shape_match).toBe(false)
    })

    it('uses err.code as errorClass when present', async () => {
        const emitter = vi.fn()
        class CodedErr extends Error { code = 'ROUTER_V2_CASCADE_EXHAUSTED' }
        await runShadowCompare({
            workspaceId: undefined,
            taskType: 'summarization',
            primary: PRIMARY_OK,
            runShadow: async () => { throw new CodedErr('exhausted') },
            emitter,
        })
        const evt = emitter.mock.calls[0]![0] as ShadowCompareEvent
        expect(evt.shadow_error_class).toBe('ROUTER_V2_CASCADE_EXHAUSTED')
    })

    it('swallows emitter exceptions (defense in depth)', async () => {
        const emitter = vi.fn(() => { throw new Error('emitter exploded') })
        await expect(runShadowCompare({
            workspaceId: 'ws-1',
            taskType: 'summarization',
            primary: PRIMARY_OK,
            runShadow: async () => ({
                text: 'hi', inputTokens: 1, outputTokens: 1, latencyMs: 5,
                model: 'm', attempts: 1,
            }),
            emitter,
        })).resolves.toBeUndefined()
        expect(emitter).toHaveBeenCalledTimes(1)
    })
})
