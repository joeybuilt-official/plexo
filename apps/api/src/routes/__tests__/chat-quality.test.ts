// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Chat performance + quality regression suite.
 *
 * Covers the trivial-message fastpath, the ToolSet cache, and the
 * classifier short-circuit that were added to bring "You working?"
 * response time under 3 seconds on prod (from ~42s).
 *
 * Layer 1 — pure unit tests for the detector + cache (no mocks).
 * Layer 2 — handler-driven tests that mock every external I/O and drive
 *           the chat router's /message handler directly. These validate
 *           the control-flow decisions (fastpath vs classifier vs
 *           executor), NOT live model quality.
 *
 * Failing any of these blocks the ship gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isTrivialMessage, buildTrivialSystemPrompt } from '../../lib/trivial-message.js'
import {
    getCachedToolSet,
    invalidateAllToolSets,
    getToolSetCacheStats,
    TOOL_SET_TTL_MS,
} from '../../lib/tool-set-cache.js'

// ────────────────────────────────────────────────────────────────────────────
// Hoisted mocks — vi.mock is lifted to the top of the file before any
// imports, which is the only way to intercept chat.ts's static imports.
// Every external dep we touch gets a default stub here, then individual
// tests customise behaviour via the shared state object `ctl` below.
// ────────────────────────────────────────────────────────────────────────────

type GenResult = { text: string; usage: { inputTokens: number; outputTokens: number } }

const ctl: {
    generateText: ReturnType<typeof vi.fn>
    pushTask: ReturnType<typeof vi.fn>
    recordConversation: ReturnType<typeof vi.fn>
} = {
    generateText: vi.fn(),
    pushTask: vi.fn(),
    recordConversation: vi.fn(),
}

vi.mock('ai', () => ({
    generateText: (...args: unknown[]) => ctl.generateText(...args),
    tool: vi.fn(),
}))

vi.mock('@plexo/db', () => {
    const chain: any = {
        select: vi.fn(() => chain),
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => [
            {
                id: '00000000-0000-0000-0000-00000000aaaa',
                name: 'Test WS',
                settings: { agentName: 'Plexo' },
            },
        ]),
        insert: vi.fn(() => chain),
        values: vi.fn(async () => []),
        update: vi.fn(() => chain),
        set: vi.fn(() => chain),
        delete: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        returning: vi.fn(async () => []),
    }
    return {
        db: chain,
        workspaces: {},
        tasks: {},
        taskSteps: {},
        sprints: {},
        modelsKnowledge: {},
        conversations: {},
        eq: vi.fn(),
        desc: vi.fn(),
        and: vi.fn(),
        sql: Object.assign(vi.fn(), { join: vi.fn() }),
    }
})

vi.mock('@plexo/queue', () => ({
    pushTask: (...args: unknown[]) => ctl.pushTask(...args),
}))

vi.mock('@plexo/agent/providers/registry', () => ({
    withFallback: async (_s: unknown, _t: unknown, fn: (m: unknown) => Promise<unknown>) =>
        fn({ id: 'mock-model' }),
    PROVIDER_DEFAULT_MODELS: { anthropic: 'claude-haiku-4-5' },
    buildModel: vi.fn(),
}))

vi.mock('@plexo/agent/providers/vision', () => ({
    modelSupportsVision: () => false,
    findVisionCapableModel: () => null,
    GROQ_FREE_VISION_MODEL: 'free',
}))

vi.mock('../../agent-loop.js', () => ({
    loadWorkspaceAISettings: vi.fn(async () => ({
        credential: { apiKey: 'mock' },
        aiSettings: {
            primaryProvider: 'anthropic',
            fallbackChain: [],
            providers: {
                anthropic: { provider: 'anthropic', model: 'claude-haiku-4-5' },
            },
        },
    })),
}))

vi.mock('../../conversation-log.js', () => ({
    recordConversation: (...args: unknown[]) => ctl.recordConversation(...args),
    getSessionChannelRef: vi.fn(async () => null),
    replyToChannel: vi.fn(),
    getSessionTurns: vi.fn(async () => []),
}))

vi.mock('../../channel-ai.js', () => ({
    hasRecallIntent: () => false,
    recallPriorConversation: vi.fn(async () => null),
    buildConversationSystemPrompt: (_channel: string, identity: string) => identity,
    translateErrorForUser: (e: string) => e,
}))

vi.mock('../../lib/session-resolver.js', () => ({
    resolveSessionId: vi.fn(async () => ({
        sessionId: 'sess-1',
        newMessageEmbedding: null,
        isNewSession: false,
        reason: 'continued',
    })),
    embedMessage: vi.fn(async () => null),
}))

vi.mock('../../credential-setup.js', () => ({
    detectCredentialMessage: () => null,
    autoInstallConnection: vi.fn(),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

vi.mock('../../sse-emitter.js', () => ({
    emitToWorkspace: vi.fn(),
}))

vi.mock('../../audit.js', () => ({
    audit: vi.fn(),
}))

vi.mock('../../delivery-tracker.js', () => ({
    trackDelivery: vi.fn(),
}))

vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
    trackError: vi.fn(),
}))

vi.mock('../../logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

vi.mock('@plexo/agent/memory/store', () => ({
    storeMemory: vi.fn(async () => undefined),
    rememberInstruction: vi.fn(async () => undefined),
    searchMemory: vi.fn(async () => []),
}))

vi.mock('@plexo/agent/memory/preferences', () => ({
    setPreference: vi.fn(async () => undefined),
}))

vi.mock('@plexo/agent/sprint/runner', () => ({
    runSprint: vi.fn(),
}))

vi.mock('../telegram.js', () => ({
    getTelegramToken: () => null,
    registerTelegramChannel: vi.fn(),
    telegramRouter: { use: vi.fn(), get: vi.fn(), post: vi.fn() },
}))

vi.mock('@plexo/agent/channels/reaction-manager', () => ({
    maybeReact: vi.fn(),
}))

vi.mock('@plexo/storage', () => ({
    uploadContent: vi.fn(async () => ({ url: 'https://mock/file.png' })),
}))

vi.mock('@plexo/agent/scl/expand-context', () => ({
    expandForConversation: vi.fn(async () => null),
}))

vi.mock('@plexo/agent/memory/conversation-bridge', () => ({
    hasInstructionIntent: () => false,
    persistInstruction: vi.fn(async () => undefined),
    extractConversationMemory: vi.fn(async () => undefined),
}))

vi.mock('@plexo/agent/memory/corrections', () => ({
    hasCorrectionIntent: () => false,
    recordCorrection: vi.fn(async () => undefined),
}))

vi.mock('@plexo/agent/introspection', () => ({
    buildIntrospectionSnapshot: vi.fn(async () => ({})),
    toConversationSnapshot: vi.fn(() => ({})),
}))

// ────────────────────────────────────────────────────────────────────────────
// Layer 1 — pure unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('trivial-message detector', () => {
    it('marks "You working?" as trivial', () => {
        expect(isTrivialMessage('You working?')).toBe(true)
    })

    it('marks "you working" (no question mark, lowercase) as trivial', () => {
        expect(isTrivialMessage('you working')).toBe(true)
    })

    it('marks "hi" / "hello" / "hey" as trivial', () => {
        expect(isTrivialMessage('hi')).toBe(true)
        expect(isTrivialMessage('Hello')).toBe(true)
        expect(isTrivialMessage('hey!')).toBe(true)
    })

    it('marks "thanks" / "ok" / "got it" as trivial', () => {
        expect(isTrivialMessage('thanks')).toBe(true)
        expect(isTrivialMessage('thank you')).toBe(true)
        expect(isTrivialMessage('ok')).toBe(true)
        expect(isTrivialMessage('got it')).toBe(true)
    })

    it('marks "test" / "ping" / "status" as trivial', () => {
        expect(isTrivialMessage('test')).toBe(true)
        expect(isTrivialMessage('ping')).toBe(true)
        expect(isTrivialMessage('status')).toBe(true)
    })

    it('does NOT mark a real task request as trivial', () => {
        expect(
            isTrivialMessage(
                'Create a task to review the Q4 budget report and assign it to me',
            ),
        ).toBe(false)
    })

    it('does NOT mark a multi-step request as trivial', () => {
        expect(
            isTrivialMessage(
                'Search for recent news about AI and summarize the top 3 results',
            ),
        ).toBe(false)
    })

    it('does NOT mark an ambiguous short question as trivial', () => {
        expect(isTrivialMessage('what is redis')).toBe(false)
        expect(isTrivialMessage('explain async/await')).toBe(false)
    })

    it('rejects messages over 30 characters', () => {
        const msg = 'you working ok hello long long message'
        expect(isTrivialMessage(msg)).toBe(false)
    })

    it('rejects empty / whitespace / null / undefined', () => {
        expect(isTrivialMessage('')).toBe(false)
        expect(isTrivialMessage('   ')).toBe(false)
        expect(isTrivialMessage(null)).toBe(false)
        expect(isTrivialMessage(undefined)).toBe(false)
    })

    it('builds a system prompt with the agent name interpolated', () => {
        const prompt = buildTrivialSystemPrompt('Plexo')
        expect(prompt).toContain('You are Plexo.')
        expect(prompt).toContain('brief status/greeting')
        expect(prompt).toContain('short, friendly sentence')
    })

    it('falls back to "Plexo" when the agent name is empty', () => {
        expect(buildTrivialSystemPrompt('')).toContain('You are Plexo.')
    })
})

describe('tool-set cache', () => {
    beforeEach(() => {
        invalidateAllToolSets()
    })

    it('loads the value on first call', async () => {
        const loader = vi.fn(async () => ({ foo: 'bar' }))
        const result = await getCachedToolSet('plugins:ws1', loader)
        expect(result).toEqual({ foo: 'bar' })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it('returns the cached value on the second call without re-loading', async () => {
        const loader = vi.fn(async () => ({ foo: 'bar' }))
        await getCachedToolSet('plugins:ws1', loader)
        const result = await getCachedToolSet('plugins:ws1', loader)
        expect(result).toEqual({ foo: 'bar' })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it('isolates cache entries by key', async () => {
        const loader1 = vi.fn(async () => ({ a: 1 }))
        const loader2 = vi.fn(async () => ({ b: 2 }))
        await getCachedToolSet('plugins:ws1', loader1)
        await getCachedToolSet('plugins:ws2', loader2)
        expect(loader1).toHaveBeenCalledTimes(1)
        expect(loader2).toHaveBeenCalledTimes(1)
        const stats = getToolSetCacheStats()
        expect(stats.size).toBe(2)
        expect(stats.keys).toContain('plugins:ws1')
        expect(stats.keys).toContain('plugins:ws2')
    })

    it('has a reasonable TTL (at least 30 seconds)', () => {
        expect(TOOL_SET_TTL_MS).toBeGreaterThanOrEqual(30_000)
    })

    it('invalidate() wipes the cache so the next call re-loads', async () => {
        const loader = vi.fn(async () => ({ foo: 'bar' }))
        await getCachedToolSet('plugins:ws1', loader)
        invalidateAllToolSets()
        await getCachedToolSet('plugins:ws1', loader)
        expect(loader).toHaveBeenCalledTimes(2)
    })
})

// ────────────────────────────────────────────────────────────────────────────
// Layer 2 — handler-driven control-flow tests
// ────────────────────────────────────────────────────────────────────────────

describe('chat handler fastpath vs full path', () => {
    const workspaceId = '00000000-0000-0000-0000-00000000aaaa'

    beforeEach(() => {
        ctl.generateText.mockReset()
        ctl.pushTask.mockReset()
        ctl.recordConversation.mockReset()
        ctl.recordConversation.mockResolvedValue(undefined)
    })

    function makeReqRes(body: Record<string, unknown>) {
        const req: any = { body, headers: {}, query: {} }
        let status = 200
        let payload: any = null
        const res: any = {
            status: (s: number) => {
                status = s
                return res
            },
            json: (p: any) => {
                payload = p
                return res
            },
            set: vi.fn(),
            setHeader: vi.fn(),
        }
        return { req, res, getStatus: () => status, getPayload: () => payload }
    }

    async function getHandler() {
        const mod = (await import('../chat.js')) as any
        const layer = mod.chatRouter.stack.find(
            (l: any) => l.route?.path === '/message' && l.route.methods.post,
        )
        return layer.route.stack[0].handle
    }

    it('sends "You working?" via the fastpath and returns within 3s', async () => {
        ctl.generateText.mockResolvedValue({
            text: 'Yes, I am up and running.',
            usage: { inputTokens: 5, outputTokens: 10 },
        } satisfies GenResult)

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'You working?',
        })

        const t0 = Date.now()
        await handler(req, res)
        const elapsed = Date.now() - t0

        expect(elapsed).toBeLessThan(3_000)
        const payload = getPayload()
        expect(payload).toBeTruthy()
        expect(payload.status).toBe('complete')
        expect(payload.reply).toMatch(/yes|working|ready|online|up|running|here/i)
        expect(payload.fastpath).toBe(true)
        // Exactly one model call — no classifier, no executor
        expect(ctl.generateText).toHaveBeenCalledTimes(1)
        // Fastpath must NOT push a task
        expect(ctl.pushTask).not.toHaveBeenCalled()
    })

    it('sends "Hello" via the fastpath within 3s', async () => {
        ctl.generateText.mockResolvedValue({
            text: 'Hi there!',
            usage: { inputTokens: 3, outputTokens: 3 },
        } satisfies GenResult)

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'Hello',
        })

        const t0 = Date.now()
        await handler(req, res)
        const elapsed = Date.now() - t0

        expect(elapsed).toBeLessThan(3_000)
        const payload = getPayload()
        expect(payload.status).toBe('complete')
        expect(payload.reply).toMatch(/hi|hello|hey/i)
        expect(payload.fastpath).toBe(true)
        expect(ctl.generateText).toHaveBeenCalledTimes(1)
    })

    it('does NOT fastpath "Create a task to review the Q4 budget report and assign it to me"', async () => {
        // The fast heuristic in chat.ts will classify this as non-CONVERSATION
        // because it contains "create" (and is over 5 words). It falls through
        // to the LLM classifier, which we steer to TASK, then the synth call.
        let callIdx = 0
        ctl.generateText.mockImplementation(async () => {
            callIdx++
            if (callIdx === 1) {
                return { text: 'TASK SIMPLE', usage: { inputTokens: 5, outputTokens: 3 } }
            }
            return { text: 'Review Q4 budget report', usage: { inputTokens: 5, outputTokens: 5 } }
        })
        ctl.pushTask.mockResolvedValue('task-123')

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'Create a task to review the Q4 budget report and assign it to me',
        })

        await handler(req, res)
        const payload = getPayload()
        expect(payload).toBeTruthy()
        expect(payload.fastpath).toBeUndefined()
        expect(ctl.pushTask).toHaveBeenCalledTimes(1)
        expect(payload.status).toBe('task_queued')
    })

    it('routes "let\'s start a project: ..." to PROJECT confirm without calling the classifier', async () => {
        // Explicit project intent must short-circuit the LLM classifier and
        // surface as status: 'confirm_action' + intent: 'PROJECT'. If this
        // regresses, the dashboard chat will silently drop "start a project"
        // messages into the single-task queue again.
        ctl.generateText.mockImplementation(async () => {
            // If reached, the classifier was invoked — that's a regression.
            // Return CONVERSATION so any downstream path that trips this
            // route goes the wrong way and the assertions catch it.
            return { text: 'CONVERSATION SIMPLE', usage: { inputTokens: 5, outputTokens: 3 } }
        })
        ctl.pushTask.mockResolvedValue('task-should-not-be-called')

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: "Let's start a project: create an HTML snake game",
        })

        await handler(req, res)
        const payload = getPayload()
        expect(payload).toBeTruthy()
        expect(payload.status).toBe('confirm_action')
        expect(payload.intent).toBe('PROJECT')
        expect(payload.description).toBe("Let's start a project: create an HTML snake game")
        // The classifier must NOT be consulted — the heuristic decided.
        expect(ctl.generateText).not.toHaveBeenCalled()
        // And no task should be pushed on the /message path for PROJECT.
        expect(ctl.pushTask).not.toHaveBeenCalled()
    })

    it('routes "Start new project: ..." to PROJECT confirm', async () => {
        ctl.generateText.mockImplementation(async () => ({
            text: 'CONVERSATION SIMPLE',
            usage: { inputTokens: 5, outputTokens: 3 },
        }))

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'Start new project: Create HTML-based snake game. Nothing fancy.',
        })

        await handler(req, res)
        const payload = getPayload()
        expect(payload.status).toBe('confirm_action')
        expect(payload.intent).toBe('PROJECT')
        expect(ctl.generateText).not.toHaveBeenCalled()
        expect(ctl.pushTask).not.toHaveBeenCalled()
    })

    it('does NOT mis-route "create an HTML snake game" (no project word) as PROJECT', async () => {
        // Simple TASK-ish asks without the word "project" must still route
        // through the task queue, not the sprint flow. Regression guard on
        // the explicit-project heuristic being too greedy.
        let callIdx = 0
        ctl.generateText.mockImplementation(async () => {
            callIdx++
            if (callIdx === 1) return { text: 'TASK SIMPLE', usage: { inputTokens: 5, outputTokens: 3 } }
            return { text: 'Create HTML snake game', usage: { inputTokens: 5, outputTokens: 5 } }
        })
        ctl.pushTask.mockResolvedValue('task-snake')

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'create an HTML snake game for me please',
        })

        await handler(req, res)
        const payload = getPayload()
        expect(payload.status).toBe('task_queued')
        expect(ctl.pushTask).toHaveBeenCalledTimes(1)
    })

    it('does NOT fastpath a multi-step search+summarize request', async () => {
        let callIdx = 0
        ctl.generateText.mockImplementation(async () => {
            callIdx++
            if (callIdx === 1) {
                return { text: 'TASK COMPLEX', usage: { inputTokens: 5, outputTokens: 3 } }
            }
            return {
                text: 'Search AI news and summarize top 3',
                usage: { inputTokens: 5, outputTokens: 5 },
            }
        })
        ctl.pushTask.mockResolvedValue('task-456')

        const handler = await getHandler()
        const { req, res, getPayload } = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'Search for recent news about AI and summarize the top 3 results',
        })

        await handler(req, res)
        const payload = getPayload()
        expect(payload).toBeTruthy()
        expect(payload.fastpath).toBeUndefined()
        // It either queued a task (TASK COMPLEX) or fell into PROJECT confirm —
        // either way, it's not the fastpath.
        expect(ctl.generateText.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('cache test: two trivial messages in a row both complete fast', async () => {
        ctl.generateText.mockResolvedValue({
            text: 'Yes, I am working.',
            usage: { inputTokens: 5, outputTokens: 5 },
        } satisfies GenResult)

        const handler = await getHandler()

        const r1 = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'You working?',
        })
        const t1 = Date.now()
        await handler(r1.req, r1.res)
        const e1 = Date.now() - t1

        const r2 = makeReqRes({
            workspaceId,
            sessionId: 'sess-1',
            message: 'You working?',
        })
        const t2 = Date.now()
        await handler(r2.req, r2.res)
        const e2 = Date.now() - t2

        expect(e1).toBeLessThan(3_000)
        expect(e2).toBeLessThan(3_000)
        expect(r1.getPayload().fastpath).toBe(true)
        expect(r2.getPayload().fastpath).toBe(true)
        // Exactly one model call per trivial fastpath hit.
        expect(ctl.generateText).toHaveBeenCalledTimes(2)
    })
})
