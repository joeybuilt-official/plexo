// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Executor tier routing + stripped conversational prompt — quality gate.
 *
 * Verifies the latency fix for task-pipeline conversational messages:
 *   1. isConversational tasks route to the `conversation` tier (fast chat),
 *      not `codeGeneration` (which resolves to deepseek-reasoner on prod).
 *   2. Multi-step tasks still route to `codeGeneration` (no regression).
 *   3. The stripped conversational prompt stays under ~600 input tokens.
 *   4. The full task prompt still carries the capability manifest block.
 *   5. DEFAULT_MODEL_ROUTING never maps conversation/classification/
 *      summarization to a reasoning model.
 *   6. The chat fastpath imports FASTPATH_MODEL from trivial-message.ts
 *      and sets up a pinned override at the call site.
 *
 * These are unit tests — no DB, no network, no full executor loop. We test
 * the pure helpers (`detectConversationalTask`, `selectExecutorTaskTier`,
 * `buildConversationalTaskPrompt`, `buildTaskPrompt`, `DEFAULT_MODEL_ROUTING`)
 * plus a text scan of chat.ts for the pinned FASTPATH_MODEL wiring.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
    detectConversationalTask,
    selectExecutorTaskTier,
} from '@plexo/agent/executor'
import {
    buildConversationalTaskPrompt,
    buildTaskPrompt,
} from '@plexo/agent/prompts/build-system-prompt'
import { DEFAULT_MODEL_ROUTING } from '@plexo/agent/providers/registry'
import { FASTPATH_MODEL } from '../../lib/trivial-message.js'
import type { ExecutionPlan } from '@plexo/agent/types'

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Cheap character-based token estimator. Real tiktoken isn't a dev dep. */
function estimateTokens(s: string): number {
    // ~4 chars per token for English prose — matches what we target in planning.
    return Math.ceil(s.length / 4)
}

function step(stepNumber: number, description: string, toolsRequired: string[] = []): ExecutionPlan['steps'][number] {
    return {
        stepNumber,
        description,
        toolsRequired,
        verificationMethod: 'Manual review',
        isOneWayDoor: false,
    }
}

function buildPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
    return {
        taskId: 't-1',
        goal: 'Tell me the time',
        steps: [step(1, 'Reply')],
        oneWayDoors: [],
        estimatedDurationMs: 1000,
        confidenceScore: 0.9,
        risks: [],
        ...overrides,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('detectConversationalTask', () => {
    it('flags a short, single-step, tool-free, non-ops-verb goal as conversational', () => {
        const plan = buildPlan({ goal: 'What time is it?' })
        expect(detectConversationalTask(plan)).toBe(true)
    })

    it('does NOT flag multi-step plans as conversational', () => {
        const plan = buildPlan({
            goal: 'Tell me the time',
            steps: [
                step(1, 'Read config'),
                step(2, 'Call API'),
            ],
        })
        expect(detectConversationalTask(plan)).toBe(false)
    })

    it('does NOT flag plans that require tools as conversational', () => {
        const plan = buildPlan({
            steps: [step(1, 'Write file', ['write_asset'])],
        })
        expect(detectConversationalTask(plan)).toBe(false)
    })

    it('does NOT flag ops-verb goals as conversational', () => {
        expect(detectConversationalTask(buildPlan({ goal: 'Deploy the api' }))).toBe(false)
        expect(detectConversationalTask(buildPlan({ goal: 'Build a dashboard' }))).toBe(false)
        expect(detectConversationalTask(buildPlan({ goal: 'Fix the bug in auth' }))).toBe(false)
    })

    it('does NOT flag long goals (>=200 chars) as conversational', () => {
        const plan = buildPlan({ goal: 'x'.repeat(250) })
        expect(detectConversationalTask(plan)).toBe(false)
    })
})

describe('selectExecutorTaskTier', () => {
    // Test 1: isConversational=true → conversation tier
    it('routes conversational tasks to the `conversation` tier', () => {
        const plan = buildPlan({ goal: 'What time is it?' })
        expect(selectExecutorTaskTier(plan)).toBe('conversation')
    })

    // Test 2: isConversational=false → codeGeneration tier
    it('routes substantive / multi-step tasks to `codeGeneration`', () => {
        const plan = buildPlan({
            goal: 'Deploy a new version of the api',
            steps: [
                step(1, 'Build', ['shell']),
                step(2, 'Push', ['shell']),
            ],
        })
        expect(selectExecutorTaskTier(plan)).toBe('codeGeneration')
    })
})

describe('buildConversationalTaskPrompt', () => {
    // Test 3: stripped prompt < 600 input tokens
    it('produces a stripped prompt under 600 tokens even with max blocks', () => {
        const prompt = buildConversationalTaskPrompt({
            taskType: 'conversational-task',
            agentName: 'Plexo',
            agentPersona: 'You are friendly.',
            identityLine: 'Identity: running on deepseek / deepseek-chat.',
            workspaceName: 'Dustin Personal',
            // Even if the caller accidentally passes these, they must NOT land
            // in the stripped prompt (test enforces via estimated token cap).
            compactCapabilityBlock: '\n\nCURRENT CAPABILITIES: ' + 'x'.repeat(2000),
            memoryBlock: '\n\nPRIOR WORK CONTEXT: ' + 'x'.repeat(2000),
            capabilityBlock: '\n\nCAPABILITY MANIFEST: ' + 'x'.repeat(2000),
            extensionPromptsBlock: '\n\nTOOL PROMPTS: ' + 'x'.repeat(2000),
            extensionContextBlock: '\n\nTOOL CONTEXT: ' + 'x'.repeat(2000),
            sclContextBlock: '\n\nSCL: ' + 'x'.repeat(2000),
            preferencesBlock: '\n\nWORKSPACE RULES:\n- Be concise.',
        })
        const tokens = estimateTokens(prompt)
        expect(tokens).toBeLessThan(600)
        // Sanity: the dropped blocks really were dropped.
        expect(prompt).not.toContain('CURRENT CAPABILITIES')
        expect(prompt).not.toContain('PRIOR WORK CONTEXT')
        expect(prompt).not.toContain('CAPABILITY MANIFEST')
        expect(prompt).not.toContain('TOOL PROMPTS')
        expect(prompt).not.toContain('TOOL CONTEXT')
        expect(prompt).not.toContain('SCL:')
        // But the kept blocks are still there.
        expect(prompt).toContain('Plexo')
        expect(prompt).toContain('Identity: running on')
        expect(prompt).toContain('task_complete')
        expect(prompt).toContain('WORKSPACE RULES')
    })

    it('does not mention list_my_tools / get_my_capabilities in the stripped prompt', () => {
        // These tool descriptions used to be inline in the conversational prompt
        // and nudged the model into extra tool calls. The stripped prompt tells
        // the model to answer from its own knowledge, no introspection.
        const prompt = buildConversationalTaskPrompt({
            taskType: 'conversational-task',
            agentName: 'Plexo',
        })
        expect(prompt).not.toContain('list_my_tools')
        expect(prompt).not.toContain('get_my_capabilities')
        expect(prompt).not.toContain('check_connection_status')
        expect(prompt).not.toContain('about_plexo')
    })
})

describe('buildTaskPrompt (regression — full task path unchanged)', () => {
    // Test 4: full prompt still includes capabilityBlock etc.
    it('still includes capabilityBlock / extensionPromptsBlock / sclContextBlock when provided', () => {
        const prompt = buildTaskPrompt({
            taskType: 'task',
            agentName: 'Plexo',
            identityLine: 'Identity: running on anthropic / claude-sonnet-4-5.',
            workspaceName: 'Dustin Personal',
            taskGoal: 'Deploy the api',
            plannedSteps: 5,
            capabilityBlock: '\n\nCAPABILITY MANIFEST: all tools listed here.',
            extensionPromptsBlock: '\n\nTOOL PROMPTS: prompts here.',
            extensionContextBlock: '\n\nTOOL CONTEXT: context here.',
            sclContextBlock: '\n\nWORKSPACE MEMORY (SCL): patterns here.',
            memoryBlock: '\n\nPRIOR WORK CONTEXT: history here.',
            browsingBlock: '\n\nWEB TOOLS: web_search, web_read_page, web_fetch.',
        })
        expect(prompt).toContain('CAPABILITY MANIFEST')
        expect(prompt).toContain('TOOL PROMPTS')
        expect(prompt).toContain('TOOL CONTEXT')
        expect(prompt).toContain('WORKSPACE MEMORY (SCL)')
        expect(prompt).toContain('PRIOR WORK CONTEXT')
        expect(prompt).toContain('WEB TOOLS')
        expect(prompt).toContain('Deploy the api')
    })
})

describe('DEFAULT_MODEL_ROUTING sanity', () => {
    // Test 5: no fast-tier maps to a reasoning model.
    const FAST_TIERS: Array<keyof typeof DEFAULT_MODEL_ROUTING> = [
        'conversation',
        'classification',
        'summarization',
    ]

    it.each(FAST_TIERS)('%s tier never maps to a reasoning model', (tier) => {
        const modelId = DEFAULT_MODEL_ROUTING[tier]
        expect(modelId).toBeTruthy()
        expect(modelId).not.toBe('deepseek-reasoner')
        expect(modelId).not.toMatch(/^o1/)
        expect(modelId).not.toMatch(/^o3/)
        expect(modelId).not.toMatch(/reasoner/i)
    })

    it('codeGeneration tier is also NOT deepseek-reasoner by default', () => {
        // codeGeneration is the "heavy" tier where reasoner IS semantically
        // acceptable — but the DEFAULT should still be a normal chat model.
        // Workspaces that want reasoner opt in via modelOverrides.
        expect(DEFAULT_MODEL_ROUTING.codeGeneration).not.toBe('deepseek-reasoner')
    })
})

describe('Chat fastpath pinning (FASTPATH_MODEL wiring)', () => {
    // Test 6: chat.ts imports FASTPATH_MODEL and wires it into the fastpath.
    it('FASTPATH_MODEL is a non-reasoning chat model', () => {
        expect(FASTPATH_MODEL).toBeTruthy()
        expect(FASTPATH_MODEL).not.toBe('deepseek-reasoner')
        expect(FASTPATH_MODEL).not.toMatch(/reasoner/i)
    })

    it('chat.ts imports FASTPATH_MODEL and uses it inside the trivial fastpath', () => {
        // Text scan is the simplest way to assert the wiring without driving
        // the full chat router end-to-end in a unit test.
        const chatPath = path.resolve(__dirname, '..', 'chat.ts')
        const src = readFileSync(chatPath, 'utf-8')
        expect(src).toContain("from '../lib/trivial-message.js'")
        expect(src).toContain('FASTPATH_MODEL')
        // The override must land on the classification tier (which is what
        // the fastpath routes through when deepseek is primary).
        expect(src).toMatch(/classification:\s*FASTPATH_MODEL/)
    })
})
