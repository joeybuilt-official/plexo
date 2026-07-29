// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../../channel-delivery.js', () => ({ deliverToOriginChannel: vi.fn(async () => {}) }))

import { emitToWorkspace } from '../../sse-emitter.js'
import { deliverToOriginChannel } from '../../channel-delivery.js'
import { telegramAdapter } from '../adapters/telegram-adapter.js'
import { webAdapter } from '../adapters/web-adapter.js'
import { makeLegacyAdapter } from '../adapters/legacy-adapter.js'

const UUID = '11111111-2222-4333-8444-555566667777'

beforeEach(() => vi.clearAllMocks())

describe('telegramAdapter.parse — inbound decision migration', () => {
    it('"approve <uuid>" → revision decision intent', () => {
        expect(telegramAdapter.parse({ text: `approve ${UUID}`, fromId: 42 })).toEqual({
            kind: 'decision',
            targetType: 'revision',
            targetId: UUID,
            choice: 'approve',
            actor: 'telegram:42',
        })
    })

    it('"reject <uuid>" → reject choice', () => {
        const i = telegramAdapter.parse({ text: `reject ${UUID}`, fromId: 7 })
        expect(i).toMatchObject({ kind: 'decision', choice: 'reject', targetId: UUID })
    })

    it('non-decision text → null', () => {
        expect(telegramAdapter.parse({ text: 'hello there', fromId: 1 })).toBeNull()
        expect(telegramAdapter.parse({ text: 'approve not-a-uuid', fromId: 1 })).toBeNull()
        expect(telegramAdapter.parse({})).toBeNull()
    })
})

describe('webAdapter', () => {
    it('parse(): decision body → decision intent', () => {
        expect(webAdapter.parse({ targetType: 'revision', targetId: 'rev1', choice: 'approve', actor: 'u@x' })).toEqual({
            kind: 'decision',
            targetType: 'revision',
            targetId: 'rev1',
            choice: 'approve',
            actor: 'u@x',
        })
    })

    it('parse(): inject body → inject intent; junk → null', () => {
        expect(webAdapter.parse({ taskId: 't1', text: 'do x' })).toEqual({ kind: 'inject', taskId: 't1', text: 'do x' })
        expect(webAdapter.parse({ choice: 'maybe' })).toBeNull()
        expect(webAdapter.parse(null)).toBeNull()
    })

    it('send(): emits the canonical action to the workspace SSE topic', async () => {
        await webAdapter.send({ channel: 'web', address: 'u1' }, { kind: 'notify', taskId: 't1', workspaceId: 'ws1', text: 'hi' })
        expect(emitToWorkspace).toHaveBeenCalledWith('ws1', expect.objectContaining({ type: 'channel.notify', taskId: 't1', text: 'hi' }))
    })
})

describe('makeLegacyAdapter — outbound delegates to channel-delivery', () => {
    it('parse() is a no-op (null)', () => {
        expect(makeLegacyAdapter('slack').parse({ text: 'whatever' })).toBeNull()
    })

    it('send(notify) → deliverToOriginChannel with mapped payload', async () => {
        await makeLegacyAdapter('slack').send(
            { channel: 'slack', address: 'C123' },
            { kind: 'deliver', taskId: 't9', workspaceId: 'ws9', text: 'done', assets: ['a.png'] },
        )
        expect(deliverToOriginChannel).toHaveBeenCalledWith(
            expect.objectContaining({
                taskId: 't9',
                workspaceId: 'ws9',
                context: { channel: 'slack', chatId: 'C123' },
                summary: 'done',
                outcome: 'complete',
            }),
        )
    })

    it('send() ignores non-outbound kinds', async () => {
        await makeLegacyAdapter('slack').send(
            { channel: 'slack', address: 'C123' },
            { kind: 'steer', taskId: 't1', workspaceId: 'ws1', message: 'm' },
        )
        expect(deliverToOriginChannel).not.toHaveBeenCalled()
    })
})
