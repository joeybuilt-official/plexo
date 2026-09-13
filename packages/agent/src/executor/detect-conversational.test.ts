// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Regression: a deliverable request must never be classified conversational.
 *
 * "make a snake game" passes the chat classifier as TASK, is queued, then the
 * executor's detectConversationalTask() used to call it CONVERSATION (its verb
 * list lacked `make`) and strip every tool — including write_asset — so the
 * model answered in chat and no artifact/link was produced.
 */
import { describe, it, expect } from 'vitest'
import { detectConversationalTask } from './index.js'
import type { ExecutionPlan } from '../types.js'

function plan(goal: string, toolsRequired: string[] = []): ExecutionPlan {
    return {
        taskId: 't1',
        goal,
        steps: [{ stepNumber: 1, description: goal, toolsRequired, verificationMethod: 'Review output', isOneWayDoor: false }],
        oneWayDoors: [],
        estimatedDurationMs: 0,
        confidenceScore: 0.9,
        risks: [],
    }
}

describe('detectConversationalTask', () => {
    it('is NOT conversational for a deliverable ask (the bug)', () => {
        expect(detectConversationalTask(plan('make a snake game'))).toBe(false)
        expect(detectConversationalTask(plan('draft a cold email'))).toBe(false)
        expect(detectConversationalTask(plan('build a landing page'))).toBe(false)
    })

    it('IS conversational for genuine chit-chat', () => {
        expect(detectConversationalTask(plan('you working?'))).toBe(true)
        expect(detectConversationalTask(plan('what can you do'))).toBe(true)
        expect(detectConversationalTask(plan('tell me a joke'))).toBe(true)
    })

    it('never conversational once a step declares tools', () => {
        expect(detectConversationalTask(plan('chit chat', ['write_asset']))).toBe(false)
    })

    it('never conversational for multi-step plans', () => {
        const multi: ExecutionPlan = {
            ...plan('hi'),
            steps: [
                { stepNumber: 1, description: 'a', toolsRequired: [], verificationMethod: 'x', isOneWayDoor: false },
                { stepNumber: 2, description: 'b', toolsRequired: [], verificationMethod: 'x', isOneWayDoor: false },
            ],
        }
        expect(detectConversationalTask(multi)).toBe(false)
    })
})
