import { describe, it, expect } from 'vitest'
import { classifyCapabilityGap } from './classify-capability-gap'

describe('classifyCapabilityGap', () => {
    it('flags the real deploy/host capability gap (task 01KTAXQ4)', () => {
        expect(classifyCapabilityGap(
            'The system does not have deployment capabilities and cannot create external hosted links.',
        )).toBe(true)
        expect(classifyCapabilityGap(
            "I can't actually deploy apps to getplexo.com or any external hosting service — I don't have that capability.",
        )).toBe(true)
    })

    it('flags unknown / missing tool signals', () => {
        expect(classifyCapabilityGap('ERROR: Unknown tool "publish_site" in worker')).toBe(true)
        expect(classifyCapabilityGap('no such tool: deploy')).toBe(true)
        expect(classifyCapabilityGap('No integration available for hosting')).toBe(true)
    })

    it('does NOT flag genuine tool errors (never-worse guard)', () => {
        // Strava bad-request: a tool that ran and was rejected — real failure.
        expect(classifyCapabilityGap(
            'Strava rejected the connection request because the details we sent did not match.',
        )).toBe(false)
        expect(classifyCapabilityGap('ERROR: ECONNREFUSED connecting to database')).toBe(false)
        expect(classifyCapabilityGap('A tool the task needed returned an error that could not be retried away.')).toBe(false)
        expect(classifyCapabilityGap('request was rejected: 400 Bad Request')).toBe(false)
    })

    it('defaults false on empty/nullish input', () => {
        expect(classifyCapabilityGap(null)).toBe(false)
        expect(classifyCapabilityGap(undefined)).toBe(false)
        expect(classifyCapabilityGap('')).toBe(false)
    })
})
