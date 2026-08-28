// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    buildConversationPrompt,
    buildConversationalTaskPrompt,
    buildTaskPrompt,
    buildClassifierPrompt,
    buildSystemPrompt,
    buildParallelismBlock,
} from './build-system-prompt.js'

describe('buildConversationPrompt', () => {
    it('includes Plexo identity and conversation core', () => {
        const out = buildConversationPrompt({ taskType: 'conversation', channel: 'webchat' })
        expect(out).toContain('You are Plexo — a personal AI agent for this workspace owner.')
        expect(out).toContain('Channel: Web chat.')
        expect(out).toContain('WHO YOU ARE:')
        expect(out).toContain('HOW YOU OPERATE:')
        expect(out).toContain('CONTINUATION SIGNALS:')
        expect(out).not.toContain('OUTPUT RULES FOR TELEGRAM:')
    })

    it('injects telegram rules for telegram channel', () => {
        const out = buildConversationPrompt({ taskType: 'conversation', channel: 'telegram' })
        expect(out).toContain('Channel: Telegram.')
        expect(out).toContain('OUTPUT RULES FOR TELEGRAM:')
        expect(out).toContain('Plain text only.')
    })

    it('appends extra conversation context', () => {
        const out = buildConversationPrompt({
            taskType: 'conversation',
            channel: 'webchat',
            extraConversationContext: 'Prior memory: user likes espresso.',
        })
        expect(out).toContain('Prior memory: user likes espresso.')
    })

    it('capitalises non-webchat channel label', () => {
        expect(buildConversationPrompt({ taskType: 'conversation', channel: 'slack' })).toContain('Channel: Slack.')
        expect(buildConversationPrompt({ taskType: 'conversation', channel: 'discord' })).toContain('Channel: Discord.')
    })
})

describe('buildConversationalTaskPrompt', () => {
    it('builds a minimal task_complete prompt (stripped by design)', () => {
        const out = buildConversationalTaskPrompt({
            taskType: 'conversational-task',
            agentName: 'Atlas',
            identityLine: 'Identity: running on openai / gpt-5.',
            workspaceName: 'Personal',
            // Heavy blocks are intentionally dropped by this prompt branch —
            // pass them to prove they are NOT rendered.
            compactCapabilityBlock: '\n\nCURRENT CAPABILITIES: ...',
            memoryBlock: '\n\nMEMORY_BLOCK',
            preferencesBlock: '',
            systemPromptExtra: '',
        })
        expect(out).toContain('You are Atlas, a helpful AI assistant.')
        expect(out).toContain('Identity: running on openai / gpt-5.')
        expect(out).toContain('Workspace: Personal')
        // Pin the current task_complete instruction text.
        expect(out).toContain('call the task_complete tool')
        expect(out).toContain('outcome "completed"')
        expect(out).toContain('ONLY tool call you should make')
        // Dropped-by-design blocks must NOT leak into the stripped prompt.
        expect(out).not.toContain('CURRENT CAPABILITIES: ...')
        expect(out).not.toContain('MEMORY_BLOCK')
    })

    it('defaults to Plexo when agent name omitted', () => {
        const out = buildConversationalTaskPrompt({ taskType: 'conversational-task' })
        expect(out).toContain('You are Plexo, a helpful AI assistant.')
    })
})

describe('buildTaskPrompt', () => {
    it('includes completion + tool-use rules and workspace header', () => {
        const out = buildTaskPrompt({
            taskType: 'task',
            agentName: 'Plexo',
            identityLine: 'Identity: running on anthropic / claude-4.',
            workspaceName: 'Personal',
            workspaceSummary: 'Solo operator workspace.',
            primaryRepo: 'joeybuilt/plexo',
            taskGoal: 'Refactor the executor prompt pipeline.',
            plannedSteps: 5,
        })
        expect(out).toContain('autonomous AI agent executing a task.')
        expect(out).toContain('Workspace: Personal')
        expect(out).toContain('Workspace purpose: Solo operator workspace.')
        expect(out).toContain('Default GitHub repository: joeybuilt/plexo')
        expect(out).toContain('Task goal: Refactor the executor prompt pipeline.')
        expect(out).toContain('COMPLETION RULE:')
        expect(out).toContain('TOOL-USE RULE (CRITICAL):')
        expect(out).toContain('You have 5 planned steps.')
    })

    it('passes through data blocks in canonical order', () => {
        const out = buildTaskPrompt({
            taskType: 'task',
            taskGoal: 'test',
            plannedSteps: 1,
            capabilityBlock: '\n\nCAP_BLOCK',
            browsingBlock: '\nBROWSING_BLOCK',
            selfExtensionBlock: '\n\nSELF_EXT_BLOCK',
            preferencesBlock: '\n\nPREFS_BLOCK',
            memoryBlock: '\n\nMEM_BLOCK',
        })
        const capIdx = out.indexOf('CAP_BLOCK')
        const browseIdx = out.indexOf('BROWSING_BLOCK')
        const selfIdx = out.indexOf('SELF_EXT_BLOCK')
        const prefIdx = out.indexOf('PREFS_BLOCK')
        const memIdx = out.indexOf('MEM_BLOCK')
        expect(capIdx).toBeGreaterThan(-1)
        expect(capIdx).toBeLessThan(browseIdx)
        expect(browseIdx).toBeLessThan(selfIdx)
        expect(selfIdx).toBeLessThan(prefIdx)
        expect(prefIdx).toBeLessThan(memIdx)
    })

    it('includes SCL context block only when passed', () => {
        const withSCL = buildTaskPrompt({
            taskType: 'task',
            taskGoal: 'g',
            plannedSteps: 1,
            sclContextBlock: '\n\nWORKSPACE MEMORY (SCL):\nDomain regions: ops',
        })
        expect(withSCL).toContain('WORKSPACE MEMORY (SCL):')
        const noSCL = buildTaskPrompt({ taskType: 'task', taskGoal: 'g', plannedSteps: 1 })
        expect(noSCL).not.toContain('WORKSPACE MEMORY (SCL):')
    })

    it('renders parallelization map when waves have width >= 2', () => {
        const out = buildTaskPrompt({
            taskType: 'task',
            taskGoal: 'Research three APIs and then write a summary',
            plannedSteps: 4,
            waves: [[1, 3], [2], [4]],
        })
        expect(out).toContain('PARALLELIZATION MAP')
        expect(out).toContain('Wave 1: steps 1, 3 ← may run in parallel')
        expect(out).toContain('Wave 2: step 2')
        expect(out).toContain('Wave 3: step 4')
        expect(out).toContain('spawn_subagent')
    })

    it('omits parallelization map when all waves are width 1 (sequential plan)', () => {
        const out = buildTaskPrompt({
            taskType: 'task',
            taskGoal: 'Sequential refactor',
            plannedSteps: 3,
            waves: [[1], [2], [3]],
        })
        expect(out).not.toContain('PARALLELIZATION MAP')
        expect(out).not.toContain('spawn_subagent')
    })

    it('omits parallelization map when waves is undefined', () => {
        const out = buildTaskPrompt({
            taskType: 'task',
            taskGoal: 'Simple task',
            plannedSteps: 2,
        })
        expect(out).not.toContain('PARALLELIZATION MAP')
    })
})

describe('buildParallelismBlock', () => {
    it('returns empty string for undefined waves', () => {
        expect(buildParallelismBlock(undefined)).toBe('')
    })

    it('returns empty string for empty waves', () => {
        expect(buildParallelismBlock([])).toBe('')
    })

    it('returns empty string when all waves have width 1', () => {
        expect(buildParallelismBlock([[1], [2], [3]])).toBe('')
    })

    it('renders when a wave has width >= 2', () => {
        const out = buildParallelismBlock([[1, 3], [2], [4]])
        expect(out).toContain('Wave 1: steps 1, 3 ← may run in parallel')
        expect(out).toContain('Wave 2: step 2')
        expect(out).toContain('Wave 3: step 4')
        expect(out).toContain('spawn_subagent')
    })

    it('renders when single wave has width >= 2', () => {
        const out = buildParallelismBlock([[1, 2, 3]])
        expect(out).toContain('Wave 1: steps 1, 2, 3 ← may run in parallel')
        expect(out).toContain('spawn_subagent')
    })
})

describe('buildClassifierPrompt', () => {
    it('returns a stable classifier prompt', () => {
        const out = buildClassifierPrompt()
        expect(out).toContain('Classify the last user message as TASK, PROJECT, or CONVERSATION.')
        expect(out).toContain('If confidence < 0.72 and not CONVERSATION, answer CONVERSATION.')
    })
})

describe('buildSystemPrompt (facade)', () => {
    it('dispatches by taskType', () => {
        expect(buildSystemPrompt({ taskType: 'conversation', channel: 'webchat' })).toContain('Channel: Web chat.')
        expect(buildSystemPrompt({ taskType: 'classifier' })).toContain('Classify the last user message')
        expect(buildSystemPrompt({ taskType: 'conversational-task' })).toContain('call the task_complete tool')
        expect(buildSystemPrompt({ taskType: 'task', taskGoal: 'g', plannedSteps: 1 })).toContain('COMPLETION RULE:')
    })
})
