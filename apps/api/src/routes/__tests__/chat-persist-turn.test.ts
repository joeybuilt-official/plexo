// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Characterization tests for the post-stream conversation persistence
 * use-case extracted from the streaming branch of `routes/chat.ts`.
 *
 * Pins the create-vs-update branching and the error/reply fields the
 * route relied on inline at three sites (empty-response, stream-error,
 * post-stream success). The route calls `persistTurn` with the parsed
 * turn result + ids; this test proves the branching is behavior-preserving.
 *
 * The conversation-log repo is mocked so no DB is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../conversation-log.js', () => ({
    recordConversation: vi.fn(async (p: Record<string, unknown>) => `new-${p.message}`),
    updateConversationById: vi.fn(async (_id: string, _u: Record<string, unknown>) => {}),
}))

import { persistTurn } from '../../application/chat/persistTurn.js'
import { recordConversation, updateConversationById } from '../../conversation-log.js'

const recordConversationMock = recordConversation as unknown as import('vitest').Mock
const updateConversationByIdMock = updateConversationById as unknown as import('vitest').Mock

const baseCreate = {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    source: 'dashboard',
    message: 'hi',
    intent: 'CONVERSATION',
    messageEmbedding: null as number[] | null,
    modelOverride: null as string | null,
    systemPromptOverride: null as string | null,
}

beforeEach(() => {
    recordConversationMock.mockClear()
    updateConversationByIdMock.mockClear()
    recordConversationMock.mockImplementation(async (p: Record<string, unknown>) => `new-${p.message}`)
    updateConversationByIdMock.mockResolvedValue(undefined)
})

describe('persistTurn — create-vs-update branching', () => {
    it('UPDATEs in place when conversationId is set (success)', async () => {
        const id = await persistTurn({
            conversationId: 'conv-9',
            create: baseCreate,
            status: 'complete',
            reply: 'hello back',
        })
        expect(id).toBe('conv-9')
        expect(updateConversationByIdMock).toHaveBeenCalledTimes(1)
        expect(updateConversationByIdMock).toHaveBeenCalledWith('conv-9', {
            reply: 'hello back',
            errorMsg: null,
            status: 'complete',
        })
        expect(recordConversationMock).not.toHaveBeenCalled()
    })

    it('UPDATEs in place when conversationId is set (failure)', async () => {
        const id = await persistTurn({
            conversationId: 'conv-9',
            create: baseCreate,
            status: 'failed',
            errorMsg: 'rate limited',
        })
        expect(id).toBe('conv-9')
        expect(updateConversationByIdMock).toHaveBeenCalledWith('conv-9', {
            reply: null,
            errorMsg: 'rate limited',
            status: 'failed',
        })
        expect(recordConversationMock).not.toHaveBeenCalled()
    })

    it('CREATEs when conversationId is null (success) and returns new id', async () => {
        const id = await persistTurn({
            conversationId: null,
            create: baseCreate,
            status: 'complete',
            reply: 'hello back',
        })
        expect(id).toBe('new-hi')
        expect(recordConversationMock).toHaveBeenCalledTimes(1)
        expect(recordConversationMock).toHaveBeenCalledWith({
            ...baseCreate,
            reply: 'hello back',
            errorMsg: null,
            status: 'complete',
        })
        expect(updateConversationByIdMock).not.toHaveBeenCalled()
    })

    it('CREATEs when conversationId is null (failure) with errorMsg', async () => {
        const id = await persistTurn({
            conversationId: null,
            create: baseCreate,
            status: 'failed',
            errorMsg: 'empty response',
        })
        expect(id).toBe('new-hi')
        expect(recordConversationMock).toHaveBeenCalledWith({
            ...baseCreate,
            reply: null,
            errorMsg: 'empty response',
            status: 'failed',
        })
    })

    it('passes through all create-fields (modelOverride, systemPromptOverride, embedding, intent, source)', async () => {
        await persistTurn({
            conversationId: null,
            create: {
                ...baseCreate,
                modelOverride: 'anthropic/claude-3.5',
                systemPromptOverride: 'custom prompt',
                messageEmbedding: [0.1, 0.2],
                intent: 'TASK',
                source: 'telegram',
            },
            status: 'complete',
            reply: 'ok',
        })
        const arg = recordConversationMock.mock.calls[0]![0] as Record<string, unknown>
        expect(arg.modelOverride).toBe('anthropic/claude-3.5')
        expect(arg.systemPromptOverride).toBe('custom prompt')
        expect(arg.messageEmbedding).toEqual([0.1, 0.2])
        expect(arg.intent).toBe('TASK')
        expect(arg.source).toBe('telegram')
        expect(arg.workspaceId).toBe('ws-1')
        expect(arg.sessionId).toBe('sess-1')
        expect(arg.message).toBe('hi')
    })

    it('coerces missing reply and errorMsg to null on update', async () => {
        await persistTurn({
            conversationId: 'conv-1',
            create: baseCreate,
            status: 'complete',
        })
        expect(updateConversationByIdMock).toHaveBeenCalledWith('conv-1', {
            reply: null,
            errorMsg: null,
            status: 'complete',
        })
    })

    it('coerces missing reply and errorMsg to null on create', async () => {
        await persistTurn({
            conversationId: null,
            create: baseCreate,
            status: 'failed',
        })
        expect(recordConversationMock).toHaveBeenCalledWith({
            ...baseCreate,
            reply: null,
            errorMsg: null,
            status: 'failed',
        })
    })

    it('status is forwarded verbatim (never remapped)', async () => {
        for (const status of ['complete', 'failed'] as const) {
            updateConversationByIdMock.mockClear()
            await persistTurn({ conversationId: 'c', create: baseCreate, status, reply: 'x' })
            const arg = updateConversationByIdMock.mock.calls[0]![1] as { status: string }
            expect(arg.status).toBe(status)
        }
    })

    it('empty-string reply is preserved (not coerced to null) on update', async () => {
        // The route guards !fullText separately; if it ever passes '' through,
        // the use-case must not second-guess it.
        await persistTurn({
            conversationId: 'conv-1',
            create: baseCreate,
            status: 'complete',
            reply: '',
        })
        expect(updateConversationByIdMock).toHaveBeenCalledWith('conv-1', {
            reply: '',
            errorMsg: null,
            status: 'complete',
        })
    })
})