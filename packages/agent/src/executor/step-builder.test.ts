// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for step-builder.ts — checkpoint/resume helpers for the
 * iterative agent loop.
 *
 * Pure functions (extractToolCalls, hasTaskComplete) are tested without any
 * mocks. DB-dependent functions (getResumeStep, buildResumeMessages) use a
 * lightweight @plexo/db mock so no real database is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── DB mock ───────────────────────────────────────────────────────────────────
// We create a flexible chain that supports both:
//   .from().where().orderBy().limit()  (getResumeStep)
//   .from().where().orderBy()          (buildResumeMessages — awaited directly)

let _dbResolve: unknown[] = []

vi.mock('@plexo/db', () => {
    function makeThenable(val: () => unknown[]) {
        return {
            limit: vi.fn(() => Promise.resolve(val())),
            then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(val()).then(resolve, reject),
            catch: (reject: (e: unknown) => unknown) => Promise.resolve(val()).catch(reject),
        }
    }
    function makeChain(val: () => unknown[]) {
        const chain: Record<string, unknown> = {}
        chain['from'] = vi.fn(() => chain)
        chain['where'] = vi.fn(() => chain)
        chain['orderBy'] = vi.fn(() => makeThenable(val))
        return chain
    }
    return {
        db: { select: vi.fn() },
        taskSteps: {
            taskId: 'task_id',
            stepNumber: 'step_number',
            isTerminal: 'is_terminal',
            stepState: 'step_state',
        },
        eq: vi.fn(),
        desc: vi.fn(),
        sql: vi.fn(),
    }
})

import { db } from '@plexo/db'
import {
    extractToolCalls,
    hasTaskComplete,
    getResumeStep,
    buildResumeMessages,
} from './step-builder.js'

function configureDb(rows: unknown[]) {
    _dbResolve = rows
    function makeThenable(val: () => unknown[]) {
        return {
            limit: vi.fn(() => Promise.resolve(val())),
            then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(val()).then(resolve, reject),
            catch: (reject: (e: unknown) => unknown) => Promise.resolve(val()).catch(reject),
        }
    }
    const chain: Record<string, unknown> = {}
    chain['from'] = vi.fn(() => chain)
    chain['where'] = vi.fn(() => chain)
    chain['orderBy'] = vi.fn(() => makeThenable(() => _dbResolve))
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>)
}

beforeEach(() => {
    vi.clearAllMocks()
    _dbResolve = []
    configureDb([])
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
        configureDb([])
        expect(await getResumeStep('task_fresh')).toBe(0)
    })

    it('returns N+1 for the last non-terminal step', async () => {
        configureDb([{ stepNumber: 3, isTerminal: false }])
        expect(await getResumeStep('task_abc')).toBe(4)
    })

    it('returns 1 when only step 0 exists and is non-terminal', async () => {
        configureDb([{ stepNumber: 0, isTerminal: false }])
        expect(await getResumeStep('task_abc')).toBe(1)
    })

    it('returns -1 when the last step was terminal', async () => {
        configureDb([{ stepNumber: 5, isTerminal: true }])
        expect(await getResumeStep('task_done')).toBe(-1)
    })
})

// ── buildResumeMessages ───────────────────────────────────────────────────────

describe('buildResumeMessages', () => {
    it('returns initial user message and resumeFromStep=0 when no steps exist', async () => {
        configureDb([])
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
        configureDb([
            { stepNumber: 0, stepState: { responseMessages: storedMsgs }, isTerminal: false },
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
        configureDb([
            { stepNumber: 0, stepState: null, isTerminal: false },
        ])
        const { messages, resumeFromStep } = await buildResumeMessages('task_3', 'sys', 'Hi')
        expect(resumeFromStep).toBe(1)
        // Only initial user msg + continuation prompt (null stepState adds nothing)
        expect(messages).toHaveLength(2)
        const last = messages[messages.length - 1] as { content: string }
        expect(last.content).toContain('resuming from a checkpoint')
    })

    it('flattens responseMessages from multiple steps in order', async () => {
        configureDb([
            { stepNumber: 0, stepState: { responseMessages: [{ role: 'assistant', content: 'Step 0' }] }, isTerminal: false },
            { stepNumber: 1, stepState: { responseMessages: [{ role: 'assistant', content: 'Step 1' }] }, isTerminal: false },
        ])
        const { messages, resumeFromStep } = await buildResumeMessages('task_4', 'sys', 'Go')
        expect(resumeFromStep).toBe(2)
        // Initial + step0 msg + step1 msg + continuation
        expect(messages).toHaveLength(4)
        expect((messages[1] as { content: string }).content).toBe('Step 0')
        expect((messages[2] as { content: string }).content).toBe('Step 1')
    })
})
