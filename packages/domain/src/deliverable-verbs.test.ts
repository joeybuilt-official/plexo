// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Deliverable-vocabulary tests. These pin the exact regression that produced
 * "make a snake game" → raw code in chat with no artifact: the executor's verb
 * list once omitted `make`, so a queued TASK was re-classified CONVERSATION and
 * its tools (including write_asset) were stripped.
 */
import { describe, it, expect } from 'vitest'
import { hasDeliverableVerb, isSelfContainedDeliverable } from './deliverable-verbs.js'

describe('hasDeliverableVerb', () => {
    it('recognizes the verbs that were missing (the bug)', () => {
        expect(hasDeliverableVerb('make a snake game')).toBe(true)
        expect(hasDeliverableVerb('draft a cold email')).toBe(true)
        expect(hasDeliverableVerb('compose a haiku')).toBe(true)
        expect(hasDeliverableVerb('design a landing page')).toBe(true)
    })

    it('recognizes the verbs that already worked', () => {
        for (const t of ['build a game', 'create a report', 'write a script', 'generate a chart', 'implement a parser']) {
            expect(hasDeliverableVerb(t), t).toBe(true)
        }
    })

    it('does not fire on chit-chat', () => {
        for (const t of ['you working?', 'what can you do', 'tell me a joke', 'hello', 'how are you today']) {
            expect(hasDeliverableVerb(t), t).toBe(false)
        }
    })

    it('respects word boundaries (no substring false positives)', () => {
        // "make" must not fire inside "makeshift"; "build" not inside "building"
        // is NOT required (gerunds are still deliverable) — but arbitrary
        // substrings like "code" inside "decode" must not match as a verb.
        expect(hasDeliverableVerb('the makeshift plan')).toBe(false)
    })
})

describe('isSelfContainedDeliverable', () => {
    it('is true for short deliverable asks', () => {
        expect(isSelfContainedDeliverable('make a snake game')).toBe(true)
    })
    it('is false for empty / conversational', () => {
        expect(isSelfContainedDeliverable('')).toBe(false)
        expect(isSelfContainedDeliverable('thanks!')).toBe(false)
    })
})
