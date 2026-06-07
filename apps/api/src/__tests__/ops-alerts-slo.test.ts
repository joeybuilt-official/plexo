// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../channel-delivery.js', () => ({ getChannelToken: () => undefined }))

import {
    evaluateSloBreaches,
    sloThresholdsFromEnv,
    recordSloBreachForAlert,
    _opsAlertBufferSizes,
    flushOpsAlerts,
    type RouterBucketStat,
} from '../ops-alerts.js'

const T = { minSuccess: 0.85, minSamples: 20, maxP95Ms: 0 }

const bucket = (over: Partial<RouterBucketStat>): RouterBucketStat => ({
    provider: 'deepseek', model: 'deepseek-v4-flash', taskType: 'extraction',
    successRate: 1, sampleCount: 100, latencyP95Ms: 500, ...over,
})

describe('evaluateSloBreaches (Round-5 Phase 9)', () => {
    it('flags a low success rate above the sample floor', () => {
        const out = evaluateSloBreaches([bucket({ successRate: 0.7, sampleCount: 50 })], T)
        expect(out).toHaveLength(1)
        expect(out[0]!.scope).toBe('deepseek/deepseek-v4-flash (extraction)')
        expect(out[0]!.successRate).toBe(0.7)
    })

    it('ignores low success when sample count is below the noise floor', () => {
        expect(evaluateSloBreaches([bucket({ successRate: 0.1, sampleCount: 5 })], T)).toHaveLength(0)
    })

    it('does not flag a healthy bucket', () => {
        expect(evaluateSloBreaches([bucket({ successRate: 0.99 })], T)).toHaveLength(0)
    })

    it('flags a p95 latency breach when maxP95Ms is set', () => {
        const out = evaluateSloBreaches([bucket({ latencyP95Ms: 9000 })], { ...T, maxP95Ms: 3000 })
        expect(out).toHaveLength(1)
        expect(out[0]!.p95Ms).toBe(9000)
    })

    it('does not check latency when maxP95Ms is 0', () => {
        expect(evaluateSloBreaches([bucket({ latencyP95Ms: 99999 })], T)).toHaveLength(0)
    })
})

describe('sloThresholdsFromEnv', () => {
    const saved = { ...process.env }
    afterEach(() => { process.env = { ...saved } })

    it('returns defaults when unset', () => {
        delete process.env.PLEXO_SLO_MIN_SUCCESS
        const t = sloThresholdsFromEnv()
        expect(t).toEqual({ minSuccess: 0.85, minSamples: 20, maxP95Ms: 0 })
    })

    it('returns null (disabled) when PLEXO_SLO_MIN_SUCCESS=0', () => {
        process.env.PLEXO_SLO_MIN_SUCCESS = '0'
        expect(sloThresholdsFromEnv()).toBeNull()
    })

    it('honors overrides', () => {
        process.env.PLEXO_SLO_MIN_SUCCESS = '0.9'
        process.env.PLEXO_SLO_MIN_SAMPLES = '50'
        process.env.PLEXO_SLO_MAX_P95_MS = '4000'
        expect(sloThresholdsFromEnv()).toEqual({ minSuccess: 0.9, minSamples: 50, maxP95Ms: 4000 })
    })
})

describe('slo ops-alert stream', () => {
    beforeEach(async () => {
        delete process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
        delete process.env.PLEXO_OPS_ALERT_CHAT_ID
        await flushOpsAlerts()
    })

    it('buffers + clears SLO breaches through the batched flush', async () => {
        recordSloBreachForAlert({ scope: 'deepseek/x (extraction)', successRate: 0.6, sampleCount: 40, p95Ms: 800 })
        expect(_opsAlertBufferSizes().slo).toBe(1)
        await flushOpsAlerts()
        expect(_opsAlertBufferSizes().slo).toBe(0)
    })
})
