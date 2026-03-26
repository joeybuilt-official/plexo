// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 (P4-S2): 20-message classifier fixture.
 * Tests the intent classification logic without requiring an LLM call.
 * Validates the JSON parsing, confidence threshold, and fallback behavior.
 */

import { describe, test, expect } from 'vitest'

// Inline the classification logic to avoid importing channel-ai (which needs express/redis)
type IntentLabel = 'TASK' | 'PROJECT' | 'CONVERSATION'

function classifyFromResponse(text: string): IntentLabel {
    const resText = text.trim()
    try {
        const parsed = JSON.parse(resText) as { classification?: string; confidence?: number }
        const classification = parsed.classification?.toUpperCase()
        const confidence = parsed.confidence ?? 0
        if (confidence < 0.72 && classification !== 'CONVERSATION') return 'CONVERSATION'
        if (classification === 'TASK') return 'TASK'
        if (classification === 'PROJECT') return 'PROJECT'
        return 'CONVERSATION'
    } catch {
        const upper = resText.toUpperCase()
        if (upper.startsWith('TASK')) return 'TASK'
        if (upper.startsWith('PROJECT')) return 'PROJECT'
        return 'CONVERSATION'
    }
}

interface Fixture {
    input: string // user message (for documentation)
    llmResponse: string // what the classifier LLM would return
    expected: IntentLabel
}

const fixtures: Fixture[] = [
    // Clear TASK signals
    { input: 'Fix the broken import in auth.ts', llmResponse: '{"classification":"TASK","confidence":0.96}', expected: 'TASK' },
    { input: 'Deploy the latest build to staging', llmResponse: '{"classification":"TASK","confidence":0.95}', expected: 'TASK' },
    { input: 'Yes, do it', llmResponse: '{"classification":"TASK","confidence":0.88}', expected: 'TASK' },
    { input: 'Add rate limiting to the login endpoint', llmResponse: '{"classification":"TASK","confidence":0.94}', expected: 'TASK' },

    // Clear PROJECT signals
    { input: 'Build a complete user onboarding flow with email verification', llmResponse: '{"classification":"PROJECT","confidence":0.94}', expected: 'PROJECT' },
    { input: 'Create a marketing website with blog, pricing page, and contact form', llmResponse: '{"classification":"PROJECT","confidence":0.93}', expected: 'PROJECT' },

    // Clear CONVERSATION signals
    { input: "What's wrong with auth.ts?", llmResponse: '{"classification":"CONVERSATION","confidence":0.92}', expected: 'CONVERSATION' },
    { input: 'How does the auth middleware work?', llmResponse: '{"classification":"CONVERSATION","confidence":0.91}', expected: 'CONVERSATION' },
    { input: 'Hey', llmResponse: '{"classification":"CONVERSATION","confidence":0.99}', expected: 'CONVERSATION' },
    { input: 'What model are you using?', llmResponse: '{"classification":"CONVERSATION","confidence":0.95}', expected: 'CONVERSATION' },

    // Borderline cases — below 0.72 threshold should default to CONVERSATION
    { input: 'Can you look into the login issue?', llmResponse: '{"classification":"TASK","confidence":0.66}', expected: 'CONVERSATION' },
    { input: 'Maybe fix the header?', llmResponse: '{"classification":"TASK","confidence":0.55}', expected: 'CONVERSATION' },
    { input: 'Something seems off with the API', llmResponse: '{"classification":"TASK","confidence":0.48}', expected: 'CONVERSATION' },
    { input: 'Could you possibly help with deployment?', llmResponse: '{"classification":"TASK","confidence":0.70}', expected: 'CONVERSATION' },

    // Edge: low-confidence CONVERSATION stays CONVERSATION (threshold only affects non-CONVERSATION)
    { input: 'hmm', llmResponse: '{"classification":"CONVERSATION","confidence":0.50}', expected: 'CONVERSATION' },

    // Legacy single-word responses (backward compat)
    { input: 'Run the tests', llmResponse: 'TASK', expected: 'TASK' },
    { input: 'Build a new app from scratch', llmResponse: 'PROJECT', expected: 'PROJECT' },
    { input: 'Tell me about the codebase', llmResponse: 'CONVERSATION', expected: 'CONVERSATION' },

    // Malformed JSON — should fall back to CONVERSATION
    { input: 'Test', llmResponse: '{broken json', expected: 'CONVERSATION' },
    { input: 'Test 2', llmResponse: '', expected: 'CONVERSATION' },
]

describe('Intent classifier fixture (20 messages)', () => {
    test.each(fixtures)('classifies "$input" → $expected', ({ llmResponse, expected }) => {
        expect(classifyFromResponse(llmResponse)).toBe(expected)
    })

    test('fixture has exactly 20 test cases', () => {
        expect(fixtures).toHaveLength(20)
    })

    test('borderline cases (confidence < 0.72) return CONVERSATION', () => {
        const borderline = fixtures.filter(f => {
            try {
                const parsed = JSON.parse(f.llmResponse) as { confidence?: number; classification?: string }
                return (parsed.confidence ?? 1) < 0.72 && parsed.classification !== 'CONVERSATION'
            } catch { return false }
        })
        expect(borderline.length).toBeGreaterThanOrEqual(4)
        for (const b of borderline) {
            expect(classifyFromResponse(b.llmResponse)).toBe('CONVERSATION')
        }
    })

    test('at least 18/20 expected classifications match', () => {
        const correct = fixtures.filter(f => classifyFromResponse(f.llmResponse) === f.expected)
        expect(correct.length).toBeGreaterThanOrEqual(18)
    })
})
