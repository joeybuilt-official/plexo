// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../channel-delivery.js', () => ({ getChannelToken: () => undefined }))

import {
    evaluateSloBreaches,
    sloThresholdsFromEnv,
    recordSloBreachForAlert,
    _opsAlertBufferSizes,
    _resetSloEvaluatorStateForTest,
    flushOpsAlerts,
    opsAlertDeliveryConfigured,
    type RouterBucketStat,
} from '../ops-alerts.js'

const T = { minSuccess: 0.85, minSamples: 20, maxP95Ms: 0 }

const bucket = (over: Partial<RouterBucketStat>): RouterBucketStat => ({
    provider: 'deepseek', model: 'deepseek-v4-flash', taskType: 'extraction',
    successRate: 1, sampleCount: 100, latencyP95Ms: 500, ...over,
})

describe('evaluateSloBreaches (Round-5 Phase 9)', () => {
    beforeEach(() => { _resetSloEvaluatorStateForTest() })

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

    // Regression: an in-memory router-v2 bucket whose model was quietly retired
    // (e.g. ollama/qwen2.5vl:3b extraction frozen at n=29, success=0, p95=6039)
    // used to re-fire the SAME breach every snapshot tick because the buffer
    // never received new samples but the evaluator had no memory of having
    // already emitted it. The stale-bucket guard suppresses repeats.
    it('emits a frozen-bucket breach exactly once across repeated cycles', () => {
        const frozen = bucket({
            provider: 'ollama', model: 'qwen2.5vl:3b', taskType: 'extraction',
            successRate: 0, sampleCount: 29, latencyP95Ms: 6039,
        })
        // First tick: initial observation, breach fires.
        expect(evaluateSloBreaches([frozen], T)).toHaveLength(1)
        // Subsequent ticks: same sampleCount, no new traffic → must not re-emit.
        expect(evaluateSloBreaches([frozen], T)).toHaveLength(0)
        expect(evaluateSloBreaches([frozen], T)).toHaveLength(0)
        expect(evaluateSloBreaches([frozen], T)).toHaveLength(0)
    })

    it('re-emits when the bucket receives new samples that keep it in breach', () => {
        const b1 = bucket({ successRate: 0.5, sampleCount: 30 })
        const b2 = bucket({ successRate: 0.5, sampleCount: 45 })  // new traffic, still breaching
        expect(evaluateSloBreaches([b1], T)).toHaveLength(1)
        expect(evaluateSloBreaches([b1], T)).toHaveLength(0)  // frozen
        expect(evaluateSloBreaches([b2], T)).toHaveLength(1)  // moved → re-emit
        expect(evaluateSloBreaches([b2], T)).toHaveLength(0)  // frozen again
    })

    it('flags a previously-healthy bucket that turns into a breach', () => {
        const healthy = bucket({ successRate: 0.99, sampleCount: 100 })
        const breaching = bucket({ successRate: 0.5, sampleCount: 150 })
        expect(evaluateSloBreaches([healthy], T)).toHaveLength(0)
        expect(evaluateSloBreaches([breaching], T)).toHaveLength(1)
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

describe('opsAlertDeliveryConfigured (OBS3/OBS4)', () => {
    beforeEach(() => {
        delete process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
        delete process.env.PLEXO_OPS_ALERT_CHAT_ID
        delete process.env.PLEXO_OPS_ALERT_WEBHOOK_URL
    })
    afterEach(() => {
        delete process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
        delete process.env.PLEXO_OPS_ALERT_CHAT_ID
        delete process.env.PLEXO_OPS_ALERT_WEBHOOK_URL
    })

    it('is false when no sink is set', () => {
        expect(opsAlertDeliveryConfigured()).toBe(false)
    })
    it('is true with the webhook sink alone', () => {
        process.env.PLEXO_OPS_ALERT_WEBHOOK_URL = 'https://hook.example/ops'
        expect(opsAlertDeliveryConfigured()).toBe(true)
    })
    it('is true with the Telegram trio alone', () => {
        process.env.PLEXO_OPS_ALERT_WORKSPACE_ID = 'ws-1'
        process.env.PLEXO_OPS_ALERT_CHAT_ID = 'chat-1'
        expect(opsAlertDeliveryConfigured()).toBe(true)
    })
})

describe('webhook fallback sink (OBS4)', () => {
    beforeEach(async () => {
        delete process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
        delete process.env.PLEXO_OPS_ALERT_CHAT_ID
        await flushOpsAlerts()
    })
    afterEach(() => {
        delete process.env.PLEXO_OPS_ALERT_WEBHOOK_URL
        vi.restoreAllMocks()
    })

    it('POSTs the batched alert to the webhook when Telegram is unconfigured', async () => {
        process.env.PLEXO_OPS_ALERT_WEBHOOK_URL = 'https://hook.example/ops'
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
        recordSloBreachForAlert({ scope: 'groq/x (extraction)', successRate: 0.5, sampleCount: 30, p95Ms: 900 })
        await flushOpsAlerts()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://hook.example/ops')
        expect(JSON.parse(init.body as string)).toMatchObject({ sloCount: 1 })
        expect(_opsAlertBufferSizes().slo).toBe(0)
    })
})
