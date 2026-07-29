// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGenerateText = vi.fn()

vi.mock('ai', async () => ({
    generateText: mockGenerateText,
    tool: (def: unknown) => def,
    stepCountIs: (n: number) => n,
}))

vi.mock('@plexo/agent/providers/registry', async () => ({
    PROVIDER_DEFAULT_MODELS: {
        anthropic: 'claude-haiku',
        openai: 'gpt-4o-mini',
        groq: 'llama-3.1-8b-instant',
        google: 'gemini-pro',
        deepseek: 'deepseek-chat',
    },
    buildModel: vi.fn(() => 'mock-model'),
}))

vi.mock('@plexo/agent/providers/router-v2', async () => ({
    routeAndCall: vi.fn(async (input: { doCall: (m: unknown) => Promise<unknown> }) => {
        return input.doCall('mock-model')
    }),
}))

vi.mock('@plexo/agent/providers/vision', async () => ({
    modelSupportsVision: vi.fn(() => false),
    findVisionCapableModel: vi.fn(() => null),
    GROQ_FREE_VISION_MODEL: 'llama-3.2-90b-vision-preview',
}))

vi.mock('@plexo/agent/principles', async () => ({
    enforceSmallestAction: vi.fn((intent: string, _msg: string) => intent),
    forceConversationOverrideWithContext: vi.fn(() => false),
    isObviousTaskRequest: vi.fn(() => false),
}))

// Phase 6: lightweight faithful mock for the unified prompt builder. Returns
// strings containing the markers channel-ai tests grep for, without pulling
// the real builder (which the vitest prefix-alias for @plexo/agent can't
// resolve cleanly — same reason principles/providers are mocked above).
vi.mock('@plexo/agent/prompts/build-system-prompt', async () => {
    const buildConversationPrompt = vi.fn(
        ({ channel, extraConversationContext }: { channel?: string; extraConversationContext?: string } = {}) => {
            const ch = channel ?? 'webchat'
            const hint = ch === 'webchat'
                ? 'Channel: Web chat.'
                : `Channel: ${ch.charAt(0).toUpperCase() + ch.slice(1)}. Keep replies conversational.`
            const tg = ch === 'telegram'
                ? '\nOUTPUT RULES FOR TELEGRAM:\n- Plain text only. No markdown.'
                : ''
            const extra = extraConversationContext ? `\n${extraConversationContext}` : ''
            return `You are Plexo — a personal AI agent for this workspace owner.\n${hint}${tg}${extra}\nWHO YOU ARE: A capable, direct assistant with sovereign access to this workspace.`
        },
    )
    return {
        buildConversationPrompt,
        buildClassifierPrompt: vi.fn(() =>
            'Classify the last user message as TASK, PROJECT, or CONVERSATION.\n\n'
            + 'Reply with JSON only: {"classification":"TASK"|"PROJECT"|"CONVERSATION","confidence":0.0-1.0}'),
        buildConversationalTaskPrompt: vi.fn(() => 'mock-conversational-task-prompt'),
        buildTaskPrompt: vi.fn(() => 'mock-task-prompt'),
        buildSystemPrompt: vi.fn(() => 'mock-system-prompt'),
    }
})

vi.mock('./analytics/events.js', async () => ({
    emitClassifierDecision: vi.fn(),
}))

vi.mock('./agent-loop.js', async () => ({
    loadWorkspaceAISettings: vi.fn(async () => ({
        credential: { apiKey: 'sk-test' },
        aiSettings: {
            primaryProvider: 'anthropic',
            fallbackChain: [],
            providers: { anthropic: { apiKey: 'sk-test', model: 'claude-haiku' } },
        },
    })),
}))

vi.mock('./sse-emitter.js', async () => ({
    emitToWorkspace: vi.fn(),
}))

vi.mock('./logger.js', async () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

vi.mock('./routes/search.js', async () => ({
    getDecryptedBraveKey: vi.fn(async () => null),
}))

vi.mock('@plexo/agent/tools/workspace-tools', async () => ({
    buildWorkspaceTools: vi.fn(async () => ({})),
}))

vi.mock('@plexo/agent/tools/self-knowledge-tools', async () => ({
    buildCompactCapabilitySummary: vi.fn(async () => 'CURRENT CAPABILITIES: test'),
}))

vi.mock('@plexo/agent/introspection', async () => ({
    buildIntrospectionSnapshot: vi.fn(async () => ({})),
    toConversationSnapshot: vi.fn(() => ({})),
}))

vi.mock('@plexo/db', async () => ({
    db: {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
                })),
            })),
        })),
    },
    conversations: {
        message: 'message',
        reply: 'reply',
        sessionId: 'session_id',
        createdAt: 'created_at',
        workspaceId: 'workspace_id',
        source: 'source',
    },
    eq: vi.fn(),
    desc: vi.fn(),
    sql: Object.assign(function sqlTag() { return {} }, { join: () => ({}), raw: () => ({}) }),
    and: vi.fn(),
}))

// ── Test suites ───────────────────────────────────────────────────────────────

describe('stripDisclaimers', () => {
    it('returns null for null input', async () => {
        const { stripDisclaimers } = await import('./channel-ai.js')
        expect(stripDisclaimers(null)).toBeNull()
    })

    it('strips "please consult a doctor" disclaimers', async () => {
        const { stripDisclaimers } = await import('./channel-ai.js')
        const input = 'Here is the answer. Please consult a doctor for medical advice.'
        const out = stripDisclaimers(input)
        expect(out).toContain('Here is the answer.')
        expect(out).not.toMatch(/consult a doctor/i)
    })

    it('keeps content when no disclaimer detected', async () => {
        const { stripDisclaimers } = await import('./channel-ai.js')
        const input = 'This is a normal reply with no disclaimers.'
        expect(stripDisclaimers(input)).toBe(input)
    })

    it('returns original if stripping removes everything', async () => {
        const { stripDisclaimers } = await import('./channel-ai.js')
        const input = "I'm not a doctor."
        // Would be stripped — ensure fallback returns the original
        expect(stripDisclaimers(input)).toBeTruthy()
    })

    it('strips "this is not medical advice" variants', async () => {
        const { stripDisclaimers } = await import('./channel-ai.js')
        const input = 'Drink water. This is not medical advice.'
        const out = stripDisclaimers(input)
        expect(out).toMatch(/Drink water/i)
        expect(out).not.toMatch(/not medical advice/i)
    })
})

describe('translateErrorForUser', () => {
    it('detects api key errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('invalid api key')).toMatch(/rejected the API key/i)
        expect(translateErrorForUser('401 Unauthorized')).toMatch(/rejected the API key/i)
        expect(translateErrorForUser('incorrect api key provided')).toMatch(/rejected the API key/i)
    })

    it('detects quota / billing errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('insufficient_quota exceeded')).toMatch(/billing/i)
        expect(translateErrorForUser('billing problem')).toMatch(/billing/i)
        expect(translateErrorForUser('payment required')).toMatch(/billing/i)
    })

    it('detects rate limit errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('rate limit reached')).toMatch(/rate-?limited/i)
        expect(translateErrorForUser('429 too many requests')).toMatch(/rate-?limited/i)
    })

    it('detects connection errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('ECONNREFUSED')).toMatch(/reach the AI provider/i)
        expect(translateErrorForUser('host unreachable')).toMatch(/reach the AI provider/i)
    })

    it('detects timeout errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('ETIMEDOUT')).toMatch(/timed out/i)
        expect(translateErrorForUser('Request aborted')).toMatch(/timed out/i)
    })

    it('detects content policy blocks', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('content policy violation')).toMatch(/content policy/i)
        expect(translateErrorForUser('content filter rejected the request')).toMatch(/content policy/i)
    })

    it('detects missing model errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('the model does not exist')).toMatch(/model/i)
        expect(translateErrorForUser('model not found')).toMatch(/model/i)
    })

    it('detects no provider configured', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('no AI credentials')).toMatch(/not configured|Settings/i)
    })

    it('detects cost ceiling errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        expect(translateErrorForUser('weekly cost ceiling hit')).toMatch(/Daily usage limit|Settings/i)
        expect(translateErrorForUser('budget exceeded')).toMatch(/Daily usage limit|Settings/i)
    })

    it('returns a generic message for unknown errors', async () => {
        const { translateErrorForUser } = await import('./channel-ai.js')
        const out = translateErrorForUser('something weird happened nobody expected')
        expect(out).toMatch(/something weird|Settings/i)
    })
})

describe('hasRecallIntent', () => {
    it('detects "continue where" phrases', async () => {
        const { hasRecallIntent } = await import('./channel-ai.js')
        expect(hasRecallIntent('continue where we left off')).toBe(true)
        expect(hasRecallIntent('pick up where you stopped')).toBe(true)
    })

    it('detects casual recall references', async () => {
        const { hasRecallIntent } = await import('./channel-ai.js')
        expect(hasRecallIntent('do you remember the thing?')).toBe(true)
        expect(hasRecallIntent("you didn't answer my question")).toBe(true)
    })

    it('returns false for non-recall messages', async () => {
        const { hasRecallIntent } = await import('./channel-ai.js')
        expect(hasRecallIntent('Hello there')).toBe(false)
        expect(hasRecallIntent('What is the weather today?')).toBe(false)
    })

    it('detects "try again"', async () => {
        const { hasRecallIntent } = await import('./channel-ai.js')
        expect(hasRecallIntent('try again please')).toBe(true)
    })
})

describe('buildConversationSystemPrompt', () => {
    it('includes webchat hint for webchat channel', async () => {
        const { buildConversationSystemPrompt } = await import('./channel-ai.js')
        const out = buildConversationSystemPrompt('webchat')
        expect(out).toMatch(/Web chat/)
        expect(out).toMatch(/Plexo/)
    })

    it('includes telegram output rules for telegram channel', async () => {
        const { buildConversationSystemPrompt } = await import('./channel-ai.js')
        const out = buildConversationSystemPrompt('telegram')
        expect(out).toMatch(/TELEGRAM/)
        expect(out).toMatch(/Plain text only/)
    })

    it('includes channel hint for generic channels', async () => {
        const { buildConversationSystemPrompt } = await import('./channel-ai.js')
        const out = buildConversationSystemPrompt('slack')
        expect(out).toMatch(/Slack/)
        expect(out).toMatch(/Plexo/)
    })

    it('appends extra context when provided', async () => {
        const { buildConversationSystemPrompt } = await import('./channel-ai.js')
        const out = buildConversationSystemPrompt('webchat', '=== RECENT MEMORY ===\nFoo.')
        expect(out).toMatch(/RECENT MEMORY/)
    })
})

describe('classifyIntent', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('forces CONVERSATION when principle override triggers', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValueOnce(true)

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'hi there' },
        ])
        expect(result.intent).toBe('CONVERSATION')
    })

    it('forces TASK when obvious-task fast path triggers', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValueOnce(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValueOnce(true)
        ;(principles.enforceSmallestAction as any).mockImplementationOnce((i: string) => i)

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'Deploy src/foo.ts to staging' },
        ])
        expect(result.intent).toBe('TASK')
    })

    it('falls back to rule-based when no provider configured', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValue(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValue(false)
        ;(principles.enforceSmallestAction as any).mockImplementation((i: string) => i)

        const agentLoop = await import('./agent-loop.js')
        ;(agentLoop.loadWorkspaceAISettings as any).mockResolvedValueOnce({
            credential: null,
            aiSettings: null,
        })

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'Hello how are you' },
        ])
        expect(result.intent).toBe('CONVERSATION')
    })

    it('LLM classifier path returns TASK when response parses to TASK', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValue(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValue(false)
        ;(principles.enforceSmallestAction as any).mockImplementation((i: string) => i)

        mockGenerateText.mockResolvedValueOnce({
            text: '{"classification":"TASK","confidence":0.95}',
        })

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'Fix the bug in that file' },
        ])
        expect(result.intent).toBe('TASK')
    })

    it('LLM classifier path returns CONVERSATION below confidence threshold', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValue(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValue(false)
        ;(principles.enforceSmallestAction as any).mockImplementation((i: string) => i)

        mockGenerateText.mockResolvedValueOnce({
            text: '{"classification":"TASK","confidence":0.5}',
        })

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'Maybe do a thing' },
        ])
        expect(result.intent).toBe('CONVERSATION')
    })

    it('falls back to rule-based on LLM error', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValue(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValue(false)
        ;(principles.enforceSmallestAction as any).mockImplementation((i: string) => i)

        mockGenerateText.mockRejectedValueOnce(new Error('rate limit hit'))

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'What is the weather' },
        ])
        expect(result.intent).toBe('CONVERSATION')
    })

    it('falls back when LLM returns unparseable response', async () => {
        const principles = await import('@plexo/agent/principles')
        ;(principles.forceConversationOverrideWithContext as any).mockReturnValue(false)
        ;(principles.isObviousTaskRequest as any).mockReturnValue(false)
        ;(principles.enforceSmallestAction as any).mockImplementation((i: string) => i)

        mockGenerateText.mockResolvedValueOnce({ text: 'nonsense response' })

        const { classifyIntent } = await import('./channel-ai.js')
        const result = await classifyIntent('ws-1', [
            { role: 'user', content: 'Question about something' },
        ])
        expect(result.intent).toBe('CONVERSATION')
    })
})

describe('ChannelChatHistory', () => {
    it('stores and retrieves messages by key', async () => {
        const { ChannelChatHistory } = await import('./channel-ai.js')
        const history = new ChannelChatHistory()
        history.add('key-1', 'user', 'hello')
        history.add('key-1', 'assistant', 'hi')
        const messages = history.get('key-1')
        expect(messages).toHaveLength(2)
        expect(messages?.[0]?.role).toBe('user')
        expect(messages?.[1]?.role).toBe('assistant')
    })

    it('merges consecutive same-role messages', async () => {
        const { ChannelChatHistory } = await import('./channel-ai.js')
        const history = new ChannelChatHistory()
        history.add('k', 'user', 'first')
        history.add('k', 'user', 'second')
        const messages = history.get('k')
        expect(messages).toHaveLength(1)
        expect(messages?.[0]?.content).toContain('first')
        expect(messages?.[0]?.content).toContain('second')
    })

    it('delete clears stored key', async () => {
        const { ChannelChatHistory } = await import('./channel-ai.js')
        const history = new ChannelChatHistory()
        history.add('k', 'user', 'hello')
        history.delete('k')
        expect(history.get('k')).toBeUndefined()
    })

    it('trims history beyond MAX_HISTORY size', async () => {
        const { ChannelChatHistory } = await import('./channel-ai.js')
        const history = new ChannelChatHistory()
        // Add 45 messages alternating roles (MAX_HISTORY is 40 = 20 turns × 2)
        for (let i = 0; i < 45; i++) {
            history.add('k', i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`)
        }
        const messages = history.get('k')
        expect(messages?.length).toBeLessThanOrEqual(40)
    })
})

describe('chatWithAI', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns error when no provider configured', async () => {
        const agentLoop = await import('./agent-loop.js')
        ;(agentLoop.loadWorkspaceAISettings as any).mockResolvedValueOnce({
            credential: null,
            aiSettings: null,
        })

        const { chatWithAI } = await import('./channel-ai.js')
        const result = await chatWithAI('ws-1', [{ role: 'user', content: 'hi' }])
        expect(result.text).toBeNull()
        expect(result.error).toMatch(/not configured|Settings/i)
    })

    it('translates errors from routeAndCall failures', async () => {
        const routerV2 = await import('@plexo/agent/providers/router-v2')
        ;(routerV2.routeAndCall as any).mockRejectedValueOnce(new Error('429 rate limit'))

        const { chatWithAI } = await import('./channel-ai.js')
        const result = await chatWithAI('ws-1', [{ role: 'user', content: 'hi' }])
        expect(result.text).toBeNull()
        expect(result.error).toMatch(/rate-?limited/i)
    })
})
