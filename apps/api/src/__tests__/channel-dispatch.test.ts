// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../redis-client.js', () => ({
    isRedisAvailable: () => false,
    getRedis: async () => { throw new Error('redis disabled in tests') },
}))

import {
    dispatchChannel,
    DispatchValidationError,
    _resetIdempotencyStoreForTests,
    type DispatchContext,
    type TelegramSender,
} from '../channel-dispatch.js'

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
    return {
        tenantId: 't-1',
        workspaceId: 'w-1',
        userId: 'u-1',
        traceId: 'trace-1',
        ...overrides,
    }
}

describe('channel.dispatch — validation', () => {
    beforeEach(() => _resetIdempotencyStoreForTests())

    it('rejects unknown channel', async () => {
        await expect(
            dispatchChannel(
                {
                    channel: 'fax',
                    recipientUserId: 'u',
                    message: { text: 'hi' },
                    idempotencyKey: 'k1',
                },
                ctx(),
            ),
        ).rejects.toBeInstanceOf(DispatchValidationError)
    })

    it('rejects empty recipientUserId', async () => {
        await expect(
            dispatchChannel(
                {
                    channel: 'telegram',
                    recipientUserId: '',
                    message: { text: 'hi' },
                    idempotencyKey: 'k1',
                },
                ctx(),
            ),
        ).rejects.toBeInstanceOf(DispatchValidationError)
    })

    it('rejects empty idempotencyKey', async () => {
        await expect(
            dispatchChannel(
                {
                    channel: 'telegram',
                    recipientUserId: 'u',
                    message: { text: 'hi' },
                    idempotencyKey: '',
                },
                ctx(),
            ),
        ).rejects.toBeInstanceOf(DispatchValidationError)
    })

    it('rejects empty message text', async () => {
        await expect(
            dispatchChannel(
                {
                    channel: 'telegram',
                    recipientUserId: 'u',
                    message: { text: '' },
                    idempotencyKey: 'k1',
                },
                ctx(),
            ),
        ).rejects.toBeInstanceOf(DispatchValidationError)
    })
})

describe('channel.dispatch — telegram', () => {
    beforeEach(() => _resetIdempotencyStoreForTests())

    it('sends via telegram and returns messageId + sent status', async () => {
        const sent: Array<{ chatId: string; text: string }> = []
        const sender: TelegramSender = {
            async send(args) {
                sent.push(args)
                return { ok: true, messageId: '42' }
            },
        }
        const out = await dispatchChannel(
            {
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-tg-1',
            },
            ctx({ telegramSender: sender }),
        )
        expect(out).toEqual({ deliveryStatus: 'sent', messageId: '42' })
        expect(sent).toEqual([{ chatId: '12345', text: 'hello' }])
    })

    it('returns not_implemented when no telegram token configured and no sender injected', async () => {
        const prev = process.env.TELEGRAM_BOT_TOKEN
        delete process.env.TELEGRAM_BOT_TOKEN
        try {
            const out = await dispatchChannel(
                {
                    channel: 'telegram',
                    recipientUserId: '12345',
                    message: { text: 'hello' },
                    idempotencyKey: 'k-tg-2',
                },
                ctx(),
            )
            expect(out.deliveryStatus).toBe('not_implemented')
        } finally {
            if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev
        }
    })

    it('returns failed (not throw) when underlying telegram send fails', async () => {
        const sender: TelegramSender = {
            async send() { return { ok: false, error: 'boom' } },
        }
        const out = await dispatchChannel(
            {
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-tg-3',
            },
            ctx({ telegramSender: sender }),
        )
        expect(out.deliveryStatus).toBe('failed')
    })
})

describe('channel.dispatch — non-telegram channels', () => {
    beforeEach(() => _resetIdempotencyStoreForTests())

    for (const channel of ['email', 'push', 'sms']) {
        it(`returns not_implemented cleanly for ${channel}`, async () => {
            const out = await dispatchChannel(
                {
                    channel,
                    recipientUserId: 'u',
                    message: { text: 'hi' },
                    idempotencyKey: `k-${channel}`,
                },
                ctx(),
            )
            expect(out).toEqual({ deliveryStatus: 'not_implemented' })
        })
    }
})

describe('channel.dispatch — idempotency', () => {
    beforeEach(() => _resetIdempotencyStoreForTests())

    it('returns the prior result for the same idempotencyKey within tenant', async () => {
        let calls = 0
        const sender: TelegramSender = {
            async send() {
                calls += 1
                return { ok: true, messageId: `m-${calls}` }
            },
        }
        const args = {
            channel: 'telegram',
            recipientUserId: '12345',
            message: { text: 'hello' },
            idempotencyKey: 'idem-same',
        }
        const first = await dispatchChannel(args, ctx({ telegramSender: sender }))
        const second = await dispatchChannel(args, ctx({ telegramSender: sender }))
        expect(first).toEqual({ deliveryStatus: 'sent', messageId: 'm-1' })
        expect(second).toEqual(first)
        expect(calls).toBe(1)
    })

    it('isolates idempotency by tenantId', async () => {
        let calls = 0
        const sender: TelegramSender = {
            async send() {
                calls += 1
                return { ok: true, messageId: `m-${calls}` }
            },
        }
        const args = {
            channel: 'telegram',
            recipientUserId: '12345',
            message: { text: 'hello' },
            idempotencyKey: 'idem-shared',
        }
        await dispatchChannel(args, ctx({ tenantId: 't-A', telegramSender: sender }))
        await dispatchChannel(args, ctx({ tenantId: 't-B', telegramSender: sender }))
        expect(calls).toBe(2)
    })
})
