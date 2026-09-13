// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Deliverable-vocabulary tests. These pin the exact regression that produced
 * "make a snake game" → raw code in chat with no artifact: the executor's verb
 * list once omitted `make`, so a queued TASK was re-classified CONVERSATION and
 * its tools (including write_asset) were stripped.
 */
import { describe, it, expect } from 'vitest'
import {
    hasDeliverableVerb,
    isSelfContainedDeliverable,
    requestsSoftwareArtifact,
    isSoftwareDeliverableRequest,
} from './deliverable-verbs.js'

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

describe('requestsSoftwareArtifact', () => {
    it('recognizes software/interactive nouns', () => {
        for (const t of [
            'make a snake game',
            'build a landing page',
            'write a python script',
            'create a dashboard',
            'build me a todo app',
        ]) {
            expect(requestsSoftwareArtifact(t), t).toBe(true)
        }
    })
    it('does not fire on content nouns even when a software word appears', () => {
        for (const t of [
            'write a blog post about our app',
            'write me a haiku',
            'draft a cold email',
            'write 3 instagram captions',
        ]) {
            expect(requestsSoftwareArtifact(t), t).toBe(false)
        }
    })
    it('respects word boundaries (no substring matches)', () => {
        expect(requestsSoftwareArtifact('the capital of France')).toBe(false) // no 'app'/'api' substring fire
        expect(requestsSoftwareArtifact('apples are tasty')).toBe(false) // 'app' not inside 'apples'
    })
})

describe('isSoftwareDeliverableRequest (the chat-routing predicate)', () => {
    it('true only when BOTH a deliverable verb and a software noun are present', () => {
        expect(isSoftwareDeliverableRequest('make a snake game')).toBe(true)
        expect(isSoftwareDeliverableRequest('build a landing page')).toBe(true)
        expect(isSoftwareDeliverableRequest('write a python script')).toBe(true)
        // noun but no verb → conversational
        expect(isSoftwareDeliverableRequest('what is a web app?')).toBe(false)
        expect(isSoftwareDeliverableRequest('the history of video games')).toBe(false)
        // verb but content noun → conversational
        expect(isSoftwareDeliverableRequest('write a blog post about our app')).toBe(false)
        expect(isSoftwareDeliverableRequest('write me a haiku')).toBe(false)
    })
})
