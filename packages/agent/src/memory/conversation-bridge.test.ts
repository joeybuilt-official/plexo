import { describe, it, expect } from 'vitest'
import { hasInstructionIntent, hasRevocationCondition } from './instruction-detect.js'

describe('conversation-bridge: instruction detection', () => {
    it('detects "always" style instructions', () => {
        expect(hasInstructionIntent('Always respond in bullet points')).toBe(true)
        expect(hasInstructionIntent('Never respond with long paragraphs')).toBe(true)
    })

    it('detects "I want you to" instructions', () => {
        expect(hasInstructionIntent('I want you to keep responses short')).toBe(true)
        expect(hasInstructionIntent('I need you to be more concise')).toBe(true)
    })

    it('detects tone/style directives', () => {
        expect(hasInstructionIntent('Be more concise')).toBe(true)
        expect(hasInstructionIntent('Keep it shorter')).toBe(true)
        expect(hasInstructionIntent('Be less verbose')).toBe(true)
    })

    it('detects "remember that" instructions', () => {
        expect(hasInstructionIntent('Remember that I prefer TypeScript over JavaScript')).toBe(true)
        expect(hasInstructionIntent("Don't forget I'm a backend developer")).toBe(true)
    })

    it('detects "when I ask" instructions', () => {
        expect(hasInstructionIntent('When I ask about code, show examples')).toBe(true)
    })

    it('does not flag normal questions', () => {
        expect(hasInstructionIntent('What is the weather today?')).toBe(false)
        expect(hasInstructionIntent('Can you search for recipes?')).toBe(false)
        expect(hasInstructionIntent('Tell me about quantum computing')).toBe(false)
    })

    it('does not flag greetings', () => {
        expect(hasInstructionIntent('Hello')).toBe(false)
        expect(hasInstructionIntent('Hey, how are you?')).toBe(false)
    })
})

describe('conversation-bridge: revocation detection', () => {
    it('detects "until I tell you to stop"', () => {
        expect(hasRevocationCondition('Talk like a gangster until I tell you to stop')).toBe(true)
    })

    it('detects "until further notice"', () => {
        expect(hasRevocationCondition('Use formal English until further notice')).toBe(true)
    })

    it('detects "for now"', () => {
        expect(hasRevocationCondition('Use Python for now')).toBe(true)
    })

    it('does not flag permanent instructions', () => {
        expect(hasRevocationCondition('Always respond in English')).toBe(false)
        expect(hasRevocationCondition('Keep responses short')).toBe(false)
    })
})
