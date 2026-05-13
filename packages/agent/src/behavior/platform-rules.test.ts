import { describe, it, expect } from 'vitest'
import { PLATFORM_DEFAULT_RULES } from './types.js'

describe('Platform Default Rules', () => {
    it('includes preserve_core_capabilities rule', () => {
        const rule = PLATFORM_DEFAULT_RULES.find(r => r.key === 'preserve_core_capabilities')
        expect(rule).toBeDefined()
        expect(rule!.type).toBe('safety_constraint')
        expect(rule!.locked).toBe(true)
        expect(rule!.source).toBe('platform')
        expect(rule!.value).toEqual({ type: 'boolean', value: true })
    })

    it('preserve_core_capabilities mentions image, voice, model, and channel', () => {
        const rule = PLATFORM_DEFAULT_RULES.find(r => r.key === 'preserve_core_capabilities')!
        expect(rule.description).toMatch(/image/i)
        expect(rule.description).toMatch(/voice/i)
        expect(rule.description).toMatch(/model/i)
        expect(rule.description).toMatch(/channel/i)
    })

    it('all safety_constraint rules are locked', () => {
        const safetyRules = PLATFORM_DEFAULT_RULES.filter(r => r.type === 'safety_constraint')
        expect(safetyRules.length).toBeGreaterThan(0)
        for (const rule of safetyRules) {
            expect(rule.locked).toBe(true)
        }
    })
})
