// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Characterization tests for the pure intent-classification dispatch
 * extracted from `routes/chat.ts`.
 *
 * Pins two pure steps that surround the `preClassifyIntent` heuristic
 * (still in `routes/chat-intent.ts`):
 *   - `resolveHeuristicIntent`: maps a heuristic result to a decided
 *     intent or defers to the LLM with the right execDefault.
 *   - `parseClassifyResponse`: parses the LLM classifier's free-text
 *     label into a typed intent + isComplex, failing toward execDefault.
 *
 * These tests pin the behavior that the route relied on inline so the
 * extraction is provably behavior-preserving.
 */

import { describe, it, expect } from 'vitest'
import {
    resolveHeuristicIntent,
    parseClassifyResponse,
    type HeuristicInput,
} from '../../application/chat/classifyIntent.js'

describe('resolveHeuristicIntent', () => {
    it('project → PROJECT, isComplex true', () => {
        expect(resolveHeuristicIntent({ kind: 'project' })).toEqual({
            kind: 'decided',
            intent: 'PROJECT',
            isComplex: true,
        })
    })

    it('task non-complex → TASK, isComplex false', () => {
        expect(resolveHeuristicIntent({ kind: 'task', isComplex: false })).toEqual({
            kind: 'decided',
            intent: 'TASK',
            isComplex: false,
        })
    })

    it('task complex → TASK, isComplex true', () => {
        expect(resolveHeuristicIntent({ kind: 'task', isComplex: true })).toEqual({
            kind: 'decided',
            intent: 'TASK',
            isComplex: true,
        })
    })

    it('memory → MEMORY, isComplex false', () => {
        expect(resolveHeuristicIntent({ kind: 'memory' })).toEqual({
            kind: 'decided',
            intent: 'MEMORY',
            isComplex: false,
        })
    })

    it('conversation → CONVERSATION, isComplex false', () => {
        expect(resolveHeuristicIntent({ kind: 'conversation' })).toEqual({
            kind: 'decided',
            intent: 'CONVERSATION',
            isComplex: false,
        })
    })

    it('needsLlm WITH task verb → execDefault TASK', () => {
        expect(resolveHeuristicIntent({ kind: 'needsLlm', hasTaskVerb: true })).toEqual({
            kind: 'needsLlm',
            execDefault: 'TASK',
        })
    })

    it('needsLlm WITHOUT task verb → execDefault CONVERSATION', () => {
        expect(resolveHeuristicIntent({ kind: 'needsLlm', hasTaskVerb: false })).toEqual({
            kind: 'needsLlm',
            execDefault: 'CONVERSATION',
        })
    })

    it('every HeuristicInput variant is handled (no fallthrough)', () => {
        const inputs: HeuristicInput[] = [
            { kind: 'project' },
            { kind: 'task', isComplex: false },
            { kind: 'task', isComplex: true },
            { kind: 'memory' },
            { kind: 'conversation' },
            { kind: 'needsLlm', hasTaskVerb: true },
            { kind: 'needsLlm', hasTaskVerb: false },
        ]
        for (const i of inputs) {
            const r = resolveHeuristicIntent(i)
            expect(r.kind === 'decided' || r.kind === 'needsLlm').toBe(true)
        }
    })
})

describe('parseClassifyResponse', () => {
    it('"TASK" → TASK, not complex', () => {
        expect(parseClassifyResponse('TASK', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('"TASK COMPLEX" → TASK, complex', () => {
        expect(parseClassifyResponse('TASK COMPLEX', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: true })
    })

    it('"PROJECT" → PROJECT', () => {
        expect(parseClassifyResponse('PROJECT', 'TASK')).toEqual({ intent: 'PROJECT', isComplex: false })
    })

    it('"PROJECT COMPLEX" → PROJECT, complex', () => {
        expect(parseClassifyResponse('PROJECT COMPLEX', 'TASK')).toEqual({ intent: 'PROJECT', isComplex: true })
    })

    it('"MEMORY" → MEMORY', () => {
        expect(parseClassifyResponse('MEMORY', 'TASK')).toEqual({ intent: 'MEMORY', isComplex: false })
    })

    it('"CONVERSATION" → CONVERSATION', () => {
        expect(parseClassifyResponse('CONVERSATION', 'TASK')).toEqual({ intent: 'CONVERSATION', isComplex: false })
    })

    it('case-insensitive prefix match ("task ...")', () => {
        expect(parseClassifyResponse('task with extra words', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('lowercase "project complex" → PROJECT complex', () => {
        expect(parseClassifyResponse('project complex', 'TASK')).toEqual({ intent: 'PROJECT', isComplex: true })
    })

    it('whitespace-padded label is trimmed and matched', () => {
        expect(parseClassifyResponse('  TASK  ', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('unrecognized label falls back to execDefault (TASK)', () => {
        expect(parseClassifyResponse('BANANA', 'TASK')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('unrecognized label falls back to execDefault (CONVERSATION)', () => {
        expect(parseClassifyResponse('BANANA', 'CONVERSATION')).toEqual({ intent: 'CONVERSATION', isComplex: false })
    })

    it('empty string → execDefault, not complex', () => {
        expect(parseClassifyResponse('', 'CONVERSATION')).toEqual({ intent: 'CONVERSATION', isComplex: false })
    })

    it('undefined → execDefault, not complex', () => {
        expect(parseClassifyResponse(undefined, 'TASK')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('null → execDefault, not complex', () => {
        expect(parseClassifyResponse(null, 'TASK')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('second token NOT starting with COMPLEX leaves isComplex false', () => {
        expect(parseClassifyResponse('TASK SIMPLE', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('"COMPLEX" alone (no intent token) → execDefault, not complex', () => {
        expect(parseClassifyResponse('COMPLEX', 'TASK')).toEqual({ intent: 'TASK', isComplex: false })
    })

    it('prefix tie-break: "TASKX" still matches TASK (startsWith)', () => {
        expect(parseClassifyResponse('TASKX', 'CONVERSATION')).toEqual({ intent: 'TASK', isComplex: false })
    })
})