// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Round-5 Phase 9 — chat SSE reply-stream cancel/terminate coverage.
 *
 * GET /api/chat/reply-stream/:taskId is a server-sent-events endpoint that
 * ticks every 3s until the task reaches a terminal state. Two invariants matter
 * for reconnect/cancel robustness:
 *   1. A terminal task emits its terminal event and ends the response (so the
 *      client gets a clean close to reconnect from), and
 *   2. a client disconnect (req 'close') clears the polling interval — no leak.
 *
 * Tests invoke the route handler directly (the repo's chat-router test pattern)
 * with fake req/res, mirroring chat-quality.test.ts's mock preamble.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const dbState = vi.hoisted(() => ({ taskRow: undefined as Record<string, unknown> | undefined }))

vi.mock('ai', () => ({ generateText: vi.fn(), tool: vi.fn() }))

vi.mock('@plexo/db', () => {
    const chain: any = {
        select: vi.fn(() => chain),
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        // .limit(n) → the configured task row (or none). The reply-stream's first
        // query (tasks lookup) drives the control flow.
        limit: vi.fn(async () => (dbState.taskRow ? [dbState.taskRow] : [])),
        insert: vi.fn(() => chain),
        values: vi.fn(async () => []),
        update: vi.fn(() => chain),
        set: vi.fn(() => chain),
        delete: vi.fn(() => chain),
        returning: vi.fn(async () => []),
        // Awaiting a bare chain (e.g. the allRows projection query) yields [].
        then: (resolve: (v: unknown[]) => unknown) => resolve([]),
    }
    return {
        db: chain,
        workspaces: {}, tasks: {}, taskSteps: {}, sprints: {}, sprintTasks: {}, sprintLogs: {},
        modelsKnowledge: {}, conversations: {},
        eq: vi.fn(), desc: vi.fn(), and: vi.fn(),
        sql: Object.assign(vi.fn(), { join: vi.fn() }),
    }
})

vi.mock('@plexo/queue', () => ({ pushTask: vi.fn() }))
vi.mock('@plexo/agent/providers/registry', () => ({ PROVIDER_DEFAULT_MODELS: { anthropic: 'claude-haiku-4-5' }, buildModel: vi.fn() }))
vi.mock('@plexo/agent/providers/router-v2', () => ({ routeAndCall: async (i: any) => i.doCall({ id: 'mock-model' }) }))
vi.mock('@plexo/agent/providers/vision', () => ({ modelSupportsVision: () => false, findVisionCapableModel: () => null, GROQ_FREE_VISION_MODEL: 'free' }))
vi.mock('../../agent-loop.js', () => ({ loadWorkspaceAISettings: vi.fn(async () => ({ credential: { apiKey: 'mock' }, aiSettings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic', model: 'claude-haiku-4-5' } } } })) }))
vi.mock('../../conversation-log.js', () => ({ recordConversation: vi.fn(), getSessionChannelRef: vi.fn(async () => null), replyToChannel: vi.fn(), getSessionTurns: vi.fn(async () => []) }))
vi.mock('../../channel-ai.js', () => ({ buildConversationSystemPrompt: (_c: string, id: string) => id, translateErrorForUser: (e: string) => e }))
vi.mock('../../lib/session-resolver.js', () => ({ resolveSessionId: vi.fn(async () => ({ sessionId: 'sess-1', newMessageEmbedding: null, isNewSession: false, reason: 'continued' })), embedMessage: vi.fn(async () => null) }))
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

async function getReplyStreamHandler() {
    const mod = (await import('../chat.js')) as any
    const layer = mod.chatRouter.stack.find(
        (l: any) => l.route?.path === '/reply-stream/:taskId' && l.route.methods.get,
    )
    return layer.route.stack[0].handle
}

interface FakeRes {
    setHeader: ReturnType<typeof vi.fn>
    flushHeaders: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    writes: string[]
    ended: boolean
}

function makeReqRes(taskId: string): { req: any; res: FakeRes; fireClose: () => void } {
    let closeCb: (() => void) | undefined
    const writes: string[] = []
    const res: FakeRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn((chunk: string) => { writes.push(chunk); return true }),
        end: vi.fn(function (this: FakeRes) { this.ended = true }),
        writes,
        ended: false,
    }
    const req = { params: { taskId }, on: (ev: string, cb: () => void) => { if (ev === 'close') closeCb = cb } }
    return { req, res, fireClose: () => closeCb?.() }
}

describe('chat reply-stream SSE (Round-5 Phase 9)', () => {
    let clearSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => { dbState.taskRow = undefined; clearSpy = vi.spyOn(global, 'clearInterval') })
    afterEach(() => { clearSpy.mockRestore() })

    it('sets SSE headers and emits a terminal "complete" event then ends, for a completed task', async () => {
        dbState.taskRow = { status: 'complete', outcomeSummary: 'All done.', createdAt: new Date(), projectId: null, plan: null }
        const handler = await getReplyStreamHandler()
        const { req, res, fireClose } = makeReqRes('task-complete')
        await handler(req, res)
        fireClose() // client disconnects after receiving the terminal event

        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
        const body = res.writes.join('')
        expect(body).toContain('event: complete')
        expect(body).toContain('All done.')
        expect(res.end).toHaveBeenCalled()
    })

    it('emits an error event for an unknown task', async () => {
        dbState.taskRow = undefined // task lookup returns []
        const handler = await getReplyStreamHandler()
        const { req, res } = makeReqRes('task-missing')
        await handler(req, res)
        expect(res.writes.join('')).toContain('TASK_NOT_FOUND')
        expect(res.end).toHaveBeenCalled()
    })

    it('clears the polling interval when the client disconnects mid-stream (no leak)', async () => {
        // Running task → does NOT finish on the first tick, so an interval is armed.
        dbState.taskRow = { status: 'running', outcomeSummary: null, createdAt: new Date(), projectId: null, plan: null }
        const handler = await getReplyStreamHandler()
        const { req, res, fireClose } = makeReqRes('task-running')
        await handler(req, res)            // arms setInterval after the immediate tick
        expect(res.ended).toBe(false)      // still streaming
        fireClose()                        // client cancels
        expect(clearSpy).toHaveBeenCalled() // interval cleared on disconnect
    })
})
