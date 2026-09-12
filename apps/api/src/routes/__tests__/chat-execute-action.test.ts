// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/chat/execute-action — confirm-chip coverage.
 *
 * Regression for the "intent must be TASK" bug: the chat UI's PROJECT confirm
 * chip posts `intent: 'PROJECT'`, but only the TASK branch existed, so every
 * "Create Project" click 400'd. Both confirm intents must now queue a task and
 * return `{ taskId }`.
 *
 * Handler-driven, mocking every external I/O (the repo's chat-router test
 * pattern). Asserts control flow, not live work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ctl = vi.hoisted(() => ({ pushed: [] as Array<Record<string, unknown>> }))

vi.mock('ai', () => ({ generateText: vi.fn(), tool: vi.fn() }))

vi.mock('@plexo/db', () => {
    const chain: any = {
        select: vi.fn(() => chain), from: vi.fn(() => chain), where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain), limit: vi.fn(async () => []),
        insert: vi.fn(() => chain), values: vi.fn(async () => []),
        update: vi.fn(() => chain), set: vi.fn(() => chain), delete: vi.fn(() => chain),
        returning: vi.fn(async () => []),
        then: (resolve: (v: unknown[]) => unknown) => resolve([]),
    }
    return {
        db: chain, workspaces: {}, tasks: {}, taskSteps: {}, sprints: {}, sprintTasks: {}, sprintLogs: {},
        modelsKnowledge: {}, conversations: {},
        eq: vi.fn(), desc: vi.fn(), and: vi.fn(),
        sql: Object.assign(vi.fn(), { join: vi.fn() }),
    }
})

vi.mock('@plexo/queue', () => ({
    pushTask: vi.fn(async (input: Record<string, unknown>) => { ctl.pushed.push(input); return 'task-123' }),
}))
vi.mock('@plexo/agent/providers/registry', () => ({ PROVIDER_DEFAULT_MODELS: { anthropic: 'claude-haiku-4-5' }, buildModel: vi.fn() }))
vi.mock('@plexo/agent/providers/router-v2', () => ({ routeAndCall: async (i: any) => i.doCall({ id: 'mock-model' }) }))
vi.mock('@plexo/agent/providers/vision', () => ({ modelSupportsVision: () => false, findVisionCapableModel: () => null, GROQ_FREE_VISION_MODEL: 'free' }))
vi.mock('../../agent-loop.js', () => ({ loadWorkspaceAISettings: vi.fn(async () => ({ credential: { apiKey: 'mock' }, aiSettings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic', model: 'claude-haiku-4-5' } } } })) }))
vi.mock('../../conversation-log.js', () => ({ recordConversation: vi.fn(), getSessionChannelRef: vi.fn(async () => null), replyToChannel: vi.fn(), getSessionTurns: vi.fn(async () => []) }))
vi.mock('../../channel-ai.js', () => ({ buildConversationSystemPrompt: (_c: string, id: string) => id, translateErrorForUser: (e: string) => e }))
vi.mock('../../lib/session-resolver.js', () => ({ resolveSessionId: vi.fn(async () => ({ sessionId: 'sess-1', newMessageEmbedding: null, isNewSession: false, reason: 'continued' })), embedMessage: vi.fn(async () => null), resolveUniversalSession: vi.fn(async () => ({ sessionId: 'sess-1', newMessageEmbedding: null })) }))
vi.mock('../../credential-setup.js', () => ({ detectCredentialMessage: () => null, autoInstallConnection: vi.fn() }))
vi.mock('../../middleware/workspace-access.js', () => ({ ensureWorkspaceAccess: vi.fn(async () => true) }))
vi.mock('../../sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../../audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../delivery-tracker.js', () => ({ trackDelivery: vi.fn() }))
vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }))
vi.mock('../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@plexo/agent/memory/store', () => ({ storeMemory: vi.fn(async () => undefined), rememberInstruction: vi.fn(async () => undefined), searchMemory: vi.fn(async () => []) }))
vi.mock('@plexo/agent/memory/preferences', () => ({ setPreference: vi.fn(async () => undefined) }))
vi.mock('../telegram.js', () => ({ getTelegramToken: () => null, registerTelegramChannel: vi.fn(), telegramRouter: { use: vi.fn(), get: vi.fn(), post: vi.fn() } }))
vi.mock('@plexo/agent/channels/reaction-manager', () => ({ maybeReact: vi.fn() }))
vi.mock('@plexo/storage', () => ({ uploadContent: vi.fn(async () => ({ url: 'https://mock/file.png' })) }))
vi.mock('@plexo/agent/memory/conversation-bridge', () => ({ hasInstructionIntent: () => false, persistInstruction: vi.fn(async () => undefined), extractConversationMemory: vi.fn(async () => undefined) }))
vi.mock('@plexo/agent/memory/corrections', () => ({ hasCorrectionIntent: () => false, recordCorrection: vi.fn(async () => undefined) }))

const handler: any = await (async () => {
    const mod = (await import('../chat.js')) as any
    const layer = mod.chatRouter.stack.find(
        (l: any) => l.route?.path === '/execute-action' && l.route.methods.post,
    )
    return layer.route.stack[0].handle
})()

const WS = '00000000-0000-0000-0000-000000000001'

async function call(body: Record<string, unknown>) {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this },
        json(payload: unknown) { this.body = payload; return this },
    }
    const req: any = { body, user: { id: 'u1' } }
    await handler(req, res)
    return res
}

describe('POST /api/chat/execute-action', () => {
    beforeEach(() => { ctl.pushed.length = 0 })

    it('queues a task for intent TASK and returns the taskId', async () => {
        const res = await call({ workspaceId: WS, intent: 'TASK', description: 'do a thing' })
        expect(res.statusCode).toBe(202)
        expect(res.body).toMatchObject({ taskId: 'task-123', status: 'queued' })
        expect(ctl.pushed).toHaveLength(1)
        expect(ctl.pushed[0]).toMatchObject({ workspaceId: WS, type: 'automation', source: 'dashboard' })
    })

    it('queues a task for intent PROJECT (was a 400 "intent must be TASK")', async () => {
        const res = await call({ workspaceId: WS, intent: 'PROJECT', description: 'build snake' })
        expect(res.statusCode).toBe(202)
        expect(res.body).toMatchObject({ taskId: 'task-123', status: 'queued' })
        expect(ctl.pushed).toHaveLength(1)
    })

    it('rejects an unknown intent with 400', async () => {
        const res = await call({ workspaceId: WS, intent: 'NOPE', description: 'x' })
        expect(res.statusCode).toBe(400)
        expect(res.body).toMatchObject({ error: { code: 'INVALID_INTENT' } })
        expect(ctl.pushed).toHaveLength(0)
    })

    it('rejects a malformed workspace id with 400', async () => {
        const res = await call({ workspaceId: 'not-a-uuid', intent: 'TASK', description: 'x' })
        expect(res.statusCode).toBe(400)
        expect(res.body).toMatchObject({ error: { code: 'INVALID_WORKSPACE' } })
    })
})
