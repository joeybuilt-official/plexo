// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for step-builder.ts — checkpoint/resume helpers for the
 * iterative agent loop.
 *
 * Pure functions (extractToolCalls, hasTaskComplete) are tested without any
 * setup. DB-dependent functions (getResumeStep, buildResumeMessages) run
 * against an in-memory TaskStepStore injected through the port seam, so no real
 * database and no ORM import is required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    extractToolCalls,
    hasTaskComplete,
    getResumeStep,
    buildResumeMessages,
    setTaskStepStore,
} from './step-builder.js'
import type { TaskStepStore, TaskStepRow } from '../executor.ports.js'

// ── In-memory store ─────────────────────────────────────────────────────────

let rows: TaskStepRow[] = []

const fakeStore: TaskStepStore = {
    getLastStep: async () => {
        if (rows.length === 0) return null
        const last = rows.reduce((a, b) => (b.stepNumber > a.stepNumber ? b : a))
        return { stepNumber: last.stepNumber, isTerminal: last.isTerminal }
    },
    listSteps: async () => [...rows].sort((a, b) => a.stepNumber - b.stepNumber),
}

function stepRow(p: { stepNumber: number; isTerminal: boolean; stepState?: TaskStepRow['stepState'] }): TaskStepRow {
    return { stepNumber: p.stepNumber, isTerminal: p.isTerminal, stepState: p.stepState ?? null }
}

function configure(next: TaskStepRow[]) {
    rows = next
}

beforeEach(() => {
    rows = []
    setTaskStepStore(fakeStore)
})

// ── extractToolCalls ──────────────────────────────────────────────────────────

describe('extractToolCalls', () => {
    it('returns empty array for result with no steps', () => {
        expect(extractToolCalls({ steps: [] })).toEqual([])
    })

    it('returns empty array when steps have no tool calls', () => {
        expect(extractToolCalls({ steps: [{ toolCalls: [] }] })).toEqual([])
    })

    it('extracts tool call from a single step with input', () => {
        const result = extractToolCalls({
            steps: [{
                toolCalls: [
                    { toolName: 'write_file', toolCallId: 'tc_1', input: { path: '/tmp/foo.txt', content: 'hi' } },
                ],
            }],
        })
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            tool: 'write_file',
            input: { path: '/tmp/foo.txt', content: 'hi' },
            output: '',
        })
    })

    it('defaults input to {} when the field is absent', () => {
        const result = extractToolCalls({
            steps: [{ toolCalls: [{ toolName: 'read_file', toolCallId: 'tc_2' }] }],
        })
        expect(result[0]).toMatchObject({ tool: 'read_file', input: {}, output: '' })
    })

    it('flattens tool calls across multiple steps', () => {
        const result = extractToolCalls({
            steps: [
                { toolCalls: [{ toolName: 'step1_tool', toolCallId: 'tc_1' }] },
                { toolCalls: [{ toolName: 'step2_tool', toolCallId: 'tc_2' }] },
            ],
        })
        expect(result).toHaveLength(2)
        expect(result[0]!.tool).toBe('step1_tool')
        expect(result[1]!.tool).toBe('step2_tool')
    })

    it('collects multiple tool calls from the same step', () => {
        const result = extractToolCalls({
            steps: [{
                toolCalls: [
                    { toolName: 'read_file', toolCallId: 'tc_1' },
                    { toolName: 'write_file', toolCallId: 'tc_2' },
                    { toolName: 'task_complete', toolCallId: 'tc_3' },
                ],
            }],
        })
        expect(result).toHaveLength(3)
        expect(result.map(r => r.tool)).toEqual(['read_file', 'write_file', 'task_complete'])
    })
})

// ── hasTaskComplete ───────────────────────────────────────────────────────────

describe('hasTaskComplete', () => {
    it('returns false when steps array is empty', () => {
        expect(hasTaskComplete({ steps: [] })).toBe(false)
    })

    it('returns false when a step has no toolCalls field', () => {
        expect(hasTaskComplete({ steps: [{}] })).toBe(false)
    })

    it('returns false when no tool call is task_complete', () => {
        expect(hasTaskComplete({
            steps: [{ toolCalls: [{ toolName: 'write_file' }, { toolName: 'read_file' }] }],
        })).toBe(false)
    })

    it('returns true when task_complete is the only tool call', () => {
        expect(hasTaskComplete({
            steps: [{ toolCalls: [{ toolName: 'task_complete' }] }],
        })).toBe(true)
    })

    it('returns true when task_complete appears in a later step', () => {
        expect(hasTaskComplete({
            steps: [
                { toolCalls: [{ toolName: 'write_file' }] },
                { toolCalls: [{ toolName: 'task_complete' }] },
            ],
        })).toBe(true)
    })

    it('returns true when task_complete is mixed with other tools in one step', () => {
        expect(hasTaskComplete({
            steps: [{
                toolCalls: [
                    { toolName: 'read_file' },
                    { toolName: 'task_complete' },
                    { toolName: 'log_output' },
                ],
            }],
        })).toBe(true)
    })
})

// ── getResumeStep ─────────────────────────────────────────────────────────────

describe('getResumeStep', () => {
    it('returns 0 when no steps exist', async () => {
        configure([])
        expect(await getResumeStep('task_fresh')).toBe(0)
    })

    it('returns N+1 for the last non-terminal step', async () => {
        configure([stepRow({ stepNumber: 3, isTerminal: false })])
        expect(await getResumeStep('task_abc')).toBe(4)
    })

    it('returns 1 when only step 0 exists and is non-terminal', async () => {
        configure([stepRow({ stepNumber: 0, isTerminal: false })])
        expect(await getResumeStep('task_abc')).toBe(1)
    })

    it('returns -1 when the last step was terminal', async () => {
        configure([stepRow({ stepNumber: 5, isTerminal: true })])
        expect(await getResumeStep('task_done')).toBe(-1)
    })
})

// ── buildResumeMessages ───────────────────────────────────────────────────────

describe('buildResumeMessages', () => {
    it('returns initial user message and resumeFromStep=0 when no steps exist', async () => {
        configure([])
        const { messages, resumeFromStep } = await buildResumeMessages('task_1', 'sys', 'Hello')
        expect(resumeFromStep).toBe(0)
        expect(messages).toHaveLength(1)
        expect((messages[0] as { role: string; content: string }).role).toBe('user')
        expect((messages[0] as { role: string; content: string }).content).toBe('Hello')
    })

    it('replays persisted responseMessages and appends a continuation prompt', async () => {
        const storedMsgs = [
            { role: 'assistant', content: 'Step 0 analysis' },
            { role: 'tool', content: [{ type: 'tool-result', output: 'ok' }] },
        ]
        configure([
            stepRow({ stepNumber: 0, isTerminal: false, stepState: { responseMessages: storedMsgs } }),
        ])
        const { messages, resumeFromStep } = await buildResumeMessages('task_2', 'sys', 'Build it')

        expect(resumeFromStep).toBe(1) // 1 step
        // Initial user msg + 2 replayed + continuation
        expect(messages).toHaveLength(4)
        expect((messages[0] as { content: string }).content).toBe('Build it')
        expect((messages[1] as { role: string }).role).toBe('assistant')
        // Continuation prompt
        const last = messages[messages.length - 1] as { role: string; content: string }
        expect(last.role).toBe('user')
        expect(last.content).toContain('resuming from a checkpoint')
    })

    it('handles steps with null stepState without throwing', async () => {
        configure([
            stepRow({ stepNumber: 0, isTerminal: false, stepState: null }),
        ])
        const { messages, resumeFromStep } = await buildResumeMessages('task_3', 'sys', 'Hi')
        expect(resumeFromStep).toBe(1)
        // Only initial user msg + continuation prompt (null stepState adds nothing)
        expect(messages).toHaveLength(2)
        const last = messages[messages.length - 1] as { content: string }
        expect(last.content).toContain('resuming from a checkpoint')
    })

    it('flattens responseMessages from multiple steps in order', async () => {
        configure([
            stepRow({ stepNumber: 0, isTerminal: false, stepState: { responseMessages: [{ role: 'assistant', content: 'Step 0' }] } }),
            stepRow({ stepNumber: 1, isTerminal: false, stepState: { responseMessages: [{ role: 'assistant', content: 'Step 1' }] } }),
        ])
        const { messages, resumeFromStep } = await buildResumeMessages('task_4', 'sys', 'Go')
        expect(resumeFromStep).toBe(2)
        // Initial + step0 msg + step1 msg + continuation
        expect(messages).toHaveLength(4)
        expect((messages[1] as { content: string }).content).toBe('Step 0')
        expect((messages[2] as { content: string }).content).toBe('Step 1')
    })
})
