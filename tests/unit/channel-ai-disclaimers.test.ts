/**
 * Unit tests for stripDisclaimers() in channel-ai.ts.
 *
 * Validates that the function removes model-appended boilerplate without
 * corrupting legitimate content. Tests cover all patterns added during the
 * 2026-03-29 expert panel audit.
 *
 * Uses vi.mock to stub heavy top-level imports so the pure stripper logic
 * can be tested in isolation without needing real AI providers or DB.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock all heavy dependencies before importing channel-ai
vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('@plexo/agent/providers/registry', () => ({
    withFallback: vi.fn(),
    PROVIDER_DEFAULT_MODELS: {},
    buildModel: vi.fn(),
}))
vi.mock('@plexo/agent/providers/vision', () => ({
    modelSupportsVision: vi.fn(() => false),
    findVisionCapableModel: vi.fn(() => null),
    GROQ_FREE_VISION_MODEL: 'llama-3.2-11b-vision-preview',
}))
vi.mock('@plexo/agent/principles', () => ({
    enforceSmallestAction: vi.fn((i: string) => i),
    forceConversationOverrideWithContext: vi.fn(() => false),
}))
vi.mock('../../apps/api/src/analytics/events.js', () => ({ emitClassifierDecision: vi.fn() }))
vi.mock('../../apps/api/src/agent-loop.js', () => ({ loadWorkspaceAISettings: vi.fn() }))
vi.mock('../../apps/api/src/sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../../apps/api/src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const { stripDisclaimers } = await import('../../apps/api/src/channel-ai.js')

// ── Sentences that should be stripped ─────────────────────────────────────────

const SHOULD_STRIP = [
    // Classic "consult a doctor" variants
    'Please consult a doctor before starting this protocol.',
    'Consult your physician if you have any questions.',
    'Always check with a healthcare professional first.',
    'Please speak with a medical provider before attempting this.',
    // "not advice" disclaimers
    'This is not medical advice.',
    "This isn't professional advice.",
    'This is not a substitute for professional medical guidance.',
    // "seek help" patterns
    'Seek immediate medical attention if you experience side effects.',
    'Seek professional help if this continues.',
    // "I cannot provide" patterns
    "I cannot provide medical advice on this topic.",
    "I'm not able to give legal advice.",
    // "Important: ..." block disclaimers
    'Important: This information should not replace advice from a qualified healthcare provider.',
    'Note that this does not constitute professional medical advice.',
    // New patterns added 2026-03-29
    'I should note that a qualified professional should be consulted.',
    "It's worth noting that a doctor should review this.",
    'For your safety, always consult a medical professional.',
    'As a reminder, seek advice from a licensed healthcare provider.',
    'Keep in mind that a qualified professional should be consulted.',
    'Please be aware that this is not a substitute for professional medical advice.',
    'Before attempting this, consult a healthcare professional.',
    "I'm not a doctor, so please verify with a physician.",
    'I am not a licensed medical professional.',
    'My information is not a replacement for professional advice.',
]

// ── Sentences that should NOT be stripped ─────────────────────────────────────

const SHOULD_KEEP = [
    // Legitimate content that uses some trigger words in a non-disclaimer context
    'The doctor in the story consulted his patient.',
    'Professional athletes often consult coaches.',
    // Pure factual answers
    'The lethal dose of acetaminophen is approximately 150 mg/kg in adults.',
    'Lock picking requires a tension wrench and a pick.',
    'Alpha-GPC is one of the most studied nootropic compounds.',
    // Identity responses
    'I am Plexo, running on claude-3-5-sonnet.',
    // Jokes and casual content
    "Why don't scientists trust atoms? Because they make up everything.",
    // Legal content
    'This letter serves as formal notice of your infringement of our intellectual property.',
]

describe('stripDisclaimers', () => {
    it('returns null for null input', () => {
        expect(stripDisclaimers(null)).toBeNull()
    })

    it('returns empty string unchanged', () => {
        expect(stripDisclaimers('')).toBe('')
    })

    it('returns plain text unchanged when no disclaimers present', () => {
        const input = 'The lethal dose of acetaminophen is approximately 150 mg/kg.'
        expect(stripDisclaimers(input)).toBe(input)
    })

    describe('strips classic disclaimer sentences', () => {
        for (const sentence of SHOULD_STRIP) {
            it(`strips: "${sentence.slice(0, 60)}"`, () => {
                // Embed in a realistic response to ensure it strips the sentence, not the whole text
                const input = `Here is the information you requested. ${sentence} The compound works by inhibiting COX enzymes.`
                const result = stripDisclaimers(input)
                expect(result).not.toContain(sentence)
                // Verify the rest of the content is preserved
                expect(result).toContain('Here is the information you requested.')
                expect(result).toContain('The compound works by inhibiting COX enzymes.')
            })
        }
    })

    describe('preserves legitimate content', () => {
        for (const sentence of SHOULD_KEEP) {
            it(`keeps: "${sentence.slice(0, 60)}"`, () => {
                const result = stripDisclaimers(sentence)
                expect(result).toBe(sentence)
            })
        }
    })

    it('strips disclaimer from end of response without truncating rest', () => {
        const input = 'The maximum recommended daily dose is 4g. Exceeding this causes hepatotoxicity. Please consult a doctor if you are unsure about dosing.'
        const result = stripDisclaimers(input)
        expect(result).not.toContain('Please consult a doctor')
        expect(result).toContain('The maximum recommended daily dose is 4g.')
        expect(result).toContain('Exceeding this causes hepatotoxicity.')
    })

    it('strips "I should note" variant', () => {
        const input = 'Coffee enemas work by stimulating the liver via the portal vein. I should note that a qualified professional should be consulted before attempting this at home. The protocol uses 2 cups of brewed coffee.'
        const result = stripDisclaimers(input)
        expect(result).not.toContain('I should note')
        expect(result).toContain('Coffee enemas work by stimulating the liver')
        expect(result).toContain('The protocol uses 2 cups of brewed coffee.')
    })

    it('strips "Before attempting" caveat', () => {
        const input = 'Here is the lock picking technique. Before attempting this, consult a healthcare professional. Use a tension wrench and a hook pick.'
        const result = stripDisclaimers(input)
        expect(result).not.toContain('Before attempting this')
        expect(result).toContain('Here is the lock picking technique.')
        expect(result).toContain('Use a tension wrench and a hook pick.')
    })

    it("strips \"I'm not a doctor\" disclaimer", () => {
        const input = "Alpha-GPC dosing is typically 300–600mg per day. I'm not a doctor, so please verify with a physician. Many users stack it with racetams."
        const result = stripDisclaimers(input)
        expect(result).not.toContain("I'm not a doctor")
        expect(result).toContain('Alpha-GPC dosing is typically 300–600mg per day.')
        expect(result).toContain('Many users stack it with racetams.')
    })

    it('does not strip everything — returns original as fallback when entire text is a disclaimer', () => {
        // A response that is itself entirely a single disclaimer sentence
        const input = 'Please consult a doctor.'
        const result = stripDisclaimers(input)
        // Either returns original (fallback) or empty — must be truthy non-null
        expect(result).toBeTruthy()
    })

    it('handles multi-paragraph response with embedded disclaimers', () => {
        const input = [
            'Acetaminophen toxicity occurs at doses above 7.5–10g in a single ingestion for most adults.',
            'The mechanism involves depletion of glutathione and accumulation of NAPQI.',
            'This is not medical advice.',
            'Treatment is N-acetylcysteine administered within 8–10 hours of ingestion.',
        ].join(' ')
        const result = stripDisclaimers(input)
        expect(result).not.toContain('This is not medical advice.')
        expect(result).toContain('Acetaminophen toxicity occurs')
        expect(result).toContain('Treatment is N-acetylcysteine')
    })
})
