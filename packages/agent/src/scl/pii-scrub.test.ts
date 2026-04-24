import { describe, it, expect } from 'vitest'
import { scrubPII } from './pii-scrub.js'

describe('PII scrubbing', () => {
    // ── Email ────────────────────────────────────────────────────────────────
    it('scrubs email addresses', () => {
        expect(scrubPII('Contact john@example.com for details')).toBe('Contact [EMAIL] for details')
        expect(scrubPII('Send to user.name+tag@domain.co.uk')).toBe('Send to [EMAIL]')
    })

    it('scrubs multiple emails', () => {
        const result = scrubPII('From alice@test.com to bob@test.com')
        expect(result).not.toContain('alice')
        expect(result).not.toContain('bob')
        expect(result).toContain('[EMAIL]')
    })

    // ── Phone ────────────────────────────────────────────────────────────────
    it('scrubs US phone numbers', () => {
        expect(scrubPII('Call 555-123-4567')).toContain('[PHONE]')
        expect(scrubPII('Call (555) 123-4567')).toContain('[PHONE]')
        expect(scrubPII('Call +1 555 123 4567')).toContain('[PHONE]')
    })

    it('scrubs international phone numbers', () => {
        expect(scrubPII('Call +44 20 7946 0958')).toContain('[PHONE]')
    })

    // ── SSN / IDs ────────────────────────────────────────────────────────────
    it('scrubs SSN patterns', () => {
        expect(scrubPII('SSN: 123-45-6789')).toContain('[ID]')
        expect(scrubPII('SSN: 123.45.6789')).toContain('[ID]')
    })

    // ── Financial ────────────────────────────────────────────────────────────
    it('scrubs dollar amounts', () => {
        expect(scrubPII('Total: $1,234.56')).toContain('[AMOUNT]')
        expect(scrubPII('Budget: $50')).toContain('[AMOUNT]')
    })

    it('scrubs other currencies', () => {
        expect(scrubPII('Price: £299.99')).toContain('[AMOUNT]')
        expect(scrubPII('Cost: €1.234,56')).toContain('[AMOUNT]')
    })

    // ── Dates ────────────────────────────────────────────────────────────────
    it('scrubs date formats', () => {
        expect(scrubPII('Born on 03/15/1990')).toContain('[DOB]')
        expect(scrubPII('DOB: 1990-03-15')).toContain('[DOB]')
        expect(scrubPII('Born March 15, 1990')).toContain('[DOB]')
    })

    // ── Addresses ────────────────────────────────────────────────────────────
    it('scrubs street addresses', () => {
        expect(scrubPII('Lives at 123 Main Street')).toContain('[ADDRESS]')
        expect(scrubPII('Office: 456 Oak Ave')).toContain('[ADDRESS]')
    })

    // ── API Keys ─────────────────────────────────────────────────────────────
    it('scrubs API key patterns', () => {
        expect(scrubPII('Key: sk-abc123def456ghi789jkl012mno')).toContain('[API_KEY]')
        expect(scrubPII('token-abcdefghijklmnopqrstuvwx')).toContain('[API_KEY]')
    })

    // ── Named entities ───────────────────────────────────────────────────────
    it('scrubs capitalized name sequences', () => {
        const result = scrubPII('Meeting with John Smith tomorrow')
        expect(result).not.toContain('John Smith')
        expect(result).toContain('[PERSON]')
    })

    it('scrubs multi-word names', () => {
        const result = scrubPII('Report by Sarah Jane Connor')
        expect(result).not.toContain('Sarah')
        expect(result).toContain('[PERSON]')
    })

    // ── Preservation ─────────────────────────────────────────────────────────
    it('preserves non-PII technical content', () => {
        const technical = 'Create a React component with TypeScript that handles form validation'
        expect(scrubPII(technical)).toBe(technical)
    })

    it('preserves code snippets', () => {
        const code = 'function handleSubmit(event) { event.preventDefault() }'
        expect(scrubPII(code)).toBe(code)
    })

    it('preserves single capitalized words', () => {
        // Single caps words aren't names — could be acronyms or sentence starters
        const text = 'Python is great'
        const result = scrubPII(text)
        expect(result).toContain('Python')
    })

    // ── Combinations ─────────────────────────────────────────────────────────
    it('scrubs mixed PII in a single message', () => {
        const mixed = 'Hi, I\'m John Smith (john@test.com, 555-123-4567). I need to transfer $5,000 from my account.'
        const result = scrubPII(mixed)
        expect(result).not.toContain('John Smith')
        expect(result).not.toContain('john@test.com')
        expect(result).not.toContain('555-123-4567')
        expect(result).not.toContain('$5,000')
    })

    // ── Edge cases ───────────────────────────────────────────────────────────
    it('handles empty string', () => {
        expect(scrubPII('')).toBe('')
    })

    it('handles text with no PII', () => {
        const clean = 'What is the weather forecast for tomorrow?'
        expect(scrubPII(clean)).toBe(clean)
    })

    it('collapses consecutive identical replacements', () => {
        const result = scrubPII('Contact John Smith or Jane Doe at info@example.com or support@example.com')
        // Should not have [EMAIL] [EMAIL] — collapsed to single [EMAIL]
        expect(result).not.toMatch(/\[EMAIL\]\s*\[EMAIL\]/)
    })
})
