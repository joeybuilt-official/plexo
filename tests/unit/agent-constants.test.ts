import { describe, it, expect } from 'vitest'
import { SAFETY_LIMITS, MODEL_ROUTING } from '../../packages/agent/src/constants.js'

describe('agent constants', () => {
    describe('SAFETY_LIMITS', () => {
        it('MAX_PLAN_STEPS is 100', () => {
            expect(SAFETY_LIMITS.MAX_PLAN_STEPS).toBe(100)
        })

        it('maxConsecutiveToolCalls is 200', () => {
            expect(SAFETY_LIMITS.maxConsecutiveToolCalls).toBe(200)
        })

        it('maxWallClockMs is 24 hours', () => {
            expect(SAFETY_LIMITS.maxWallClockMs).toBe(24 * 60 * 60 * 1000)
        })

        it('noForcePush is always true — not configurable', () => {
            expect(SAFETY_LIMITS.noForcePush).toBe(true)
        })

        it('noCredentialsInLogs is always true', () => {
            expect(SAFETY_LIMITS.noCredentialsInLogs).toBe(true)
        })
    })

    describe('MODEL_ROUTING', () => {
        it('has a default model', () => {
            expect(MODEL_ROUTING.default).toBeTruthy()
            expect(MODEL_ROUTING.default).toContain('claude')
        })

        it('all models are valid claude model strings', () => {
            for (const [key, model] of Object.entries(MODEL_ROUTING)) {
                expect(model, `${key} should be a Claude model`).toMatch(/^claude-/)
            }
        })
    })
})
