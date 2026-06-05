// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { preClassifyIntent } from '../chat-intent.js'

describe('preClassifyIntent', () => {
    // The regression: a build request phrased as a question must NOT be
    // treated as conversation. It carries a task verb, so it defers to the LLM
    // classifier (which routes it to TASK/PROJECT) — never a chat reply.
    it('"Build me a simple web-based flappy bird game?" → needsLlm (has task verb), not conversation', () => {
        const r = preClassifyIntent('Build me a simple web-based flappy bird game?')
        expect(r.kind).toBe('needsLlm')
        expect(r).toMatchObject({ hasTaskVerb: true })
    })

    it('build/create/write requests carry a task verb (defer to LLM, not chat)', () => {
        for (const m of [
            'create a landing page for my startup?',
            'write a python script to rename files',
            'make me a todo app',
        ]) {
            const r = preClassifyIntent(m)
            expect(r.kind, m).toBe('needsLlm')
            expect(r, m).toMatchObject({ hasTaskVerb: true })
        }
    })

    it('genuine questions with no task verb → conversation', () => {
        for (const m of ['what is a flappy bird game?', 'how does this work?', 'who are you?']) {
            expect(preClassifyIntent(m).kind, m).toBe('conversation')
        }
    })

    it('greetings and short non-task messages → conversation', () => {
        for (const m of ['hi', 'hey there', 'thanks', 'ok cool']) {
            expect(preClassifyIntent(m).kind, m).toBe('conversation')
        }
    })

    it('ops commands → task (not complex)', () => {
        const r = preClassifyIntent('restart the api container')
        expect(r).toEqual({ kind: 'task', isComplex: false })
    })

    it('explicit project → project', () => {
        expect(preClassifyIntent("let's start a new project: build a snake game").kind).toBe('project')
    })

    it('memory instructions → memory (before conversation)', () => {
        expect(preClassifyIntent('remember that I prefer dark mode').kind).toBe('memory')
    })
})
