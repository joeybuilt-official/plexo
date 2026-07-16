import { describe, it, expect } from 'vitest'
import { rankBySalience, salienceScore } from './salience.js'

describe('salienceScore', () => {
    it('decays with age', () => {
        expect(salienceScore(1, 0, 1000)).toBe(1)
        expect(salienceScore(1, 1000, 1000)).toBeCloseTo(Math.exp(-1))
        expect(salienceScore(0.5, 0, 1000)).toBe(0.5)
    })
})

describe('rankBySalience', () => {
    const now = new Date()

    it('(a) equal age, higher confidence ranks first', () => {
        const rows = [
            { content: 'low', shorthand: null, createdAt: now, confidence: 0.2 },
            { content: 'high', shorthand: null, createdAt: now, confidence: 0.9 },
        ]
        const out = rankBySalience(rows, { budgetChars: 1000, limit: 10 })
        expect(out.map(r => r.content)).toEqual(['high', 'low'])
    })

    it('(b) equal confidence, fresher createdAt ranks first', () => {
        const old = new Date(now.getTime() - 30 * 604800000)
        const rows = [
            { content: 'old', shorthand: null, createdAt: old, confidence: 0.5 },
            { content: 'fresh', shorthand: null, createdAt: now, confidence: 0.5 },
        ]
        const out = rankBySalience(rows, { budgetChars: 1000, limit: 10 })
        expect(out.map(r => r.content)).toEqual(['fresh', 'old'])
    })

    it('(c) char budget returns only the fitting prefix', () => {
        const rows = [
            { content: 'a'.repeat(100), shorthand: null, createdAt: now, confidence: 0.9 },
            { content: 'b'.repeat(100), shorthand: null, createdAt: now, confidence: 0.8 },
            { content: 'c'.repeat(100), shorthand: null, createdAt: now, confidence: 0.7 },
        ]
        const out = rankBySalience(rows, { budgetChars: 250, limit: 100 })
        expect(out).toHaveLength(2)
        expect(out.map(r => r.content[0])).toEqual(['a', 'b'])
        expect(out.some(r => r.content[0] === 'c')).toBe(false)
    })
})
