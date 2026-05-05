// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * L4.5 — multi-channel reminder support tests.
 *
 * Pins the resolver registry contract: each supported channel type maps to a
 * "is this channel dispatch-ready?" probe that returns a non-empty identifier
 * on success and null on missing required config.
 */

import { describe, it, expect } from 'vitest'
import {
    REMINDER_CHANNEL_RESOLVERS,
    resolveRecipient,
    isReminderSupportedChannelType,
} from '../lib/reminder-channel-registry.js'

describe('REMINDER_CHANNEL_RESOLVERS — multi-channel (L4.5)', () => {
    it('exposes resolvers for all five supported channel types', () => {
        const types = Object.keys(REMINDER_CHANNEL_RESOLVERS).sort()
        expect(types).toEqual(['discord', 'gmail', 'slack', 'telegram', 'twilio'])
    })

    describe('gmail', () => {
        it('returns emailAddress when present', () => {
            expect(resolveRecipient({ type: 'gmail', config: { emailAddress: 'op@example.com' } })).toBe('op@example.com')
        })
        it('returns null when emailAddress missing', () => {
            expect(resolveRecipient({ type: 'gmail', config: {} })).toBeNull()
        })
    })

    describe('twilio', () => {
        it('returns fromNumber when fromNumber + accountSid present', () => {
            expect(resolveRecipient({
                type: 'twilio',
                config: { fromNumber: '+15551234567', accountSid: 'AC' + 'a'.repeat(32) },
            })).toBe('+15551234567')
        })
        it('returns null when accountSid missing', () => {
            expect(resolveRecipient({ type: 'twilio', config: { fromNumber: '+15551234567' } })).toBeNull()
        })
        it('returns null when fromNumber missing', () => {
            expect(resolveRecipient({ type: 'twilio', config: { accountSid: 'AC' + 'a'.repeat(32) } })).toBeNull()
        })
    })

    describe('telegram', () => {
        it('returns "telegram-bot" sentinel when token present', () => {
            expect(resolveRecipient({ type: 'telegram', config: { token: 'bot:secret' } })).toBe('telegram-bot')
        })
        it('also accepts bot_token snake_case (legacy)', () => {
            expect(resolveRecipient({ type: 'telegram', config: { bot_token: 'bot:secret' } })).toBe('telegram-bot')
        })
        it('returns null when neither token nor bot_token', () => {
            expect(resolveRecipient({ type: 'telegram', config: {} })).toBeNull()
        })
    })

    describe('slack', () => {
        it('returns webhook URL', () => {
            expect(resolveRecipient({ type: 'slack', config: { webhook: 'https://hooks.slack.com/services/xxx' } }))
                .toBe('https://hooks.slack.com/services/xxx')
        })
        it('accepts webhookUrl + webhook_url variants', () => {
            expect(resolveRecipient({ type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/yyy' } }))
                .toBe('https://hooks.slack.com/services/yyy')
            expect(resolveRecipient({ type: 'slack', config: { webhook_url: 'https://hooks.slack.com/services/zzz' } }))
                .toBe('https://hooks.slack.com/services/zzz')
        })
    })

    describe('discord', () => {
        it('returns webhook URL', () => {
            expect(resolveRecipient({ type: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/123/abc' } }))
                .toBe('https://discord.com/api/webhooks/123/abc')
        })
    })

    describe('isReminderSupportedChannelType', () => {
        it('accepts the five supported types', () => {
            for (const t of ['gmail', 'twilio', 'telegram', 'slack', 'discord']) {
                expect(isReminderSupportedChannelType(t)).toBe(true)
            }
        })
        it('rejects deprecated dead-UI types', () => {
            for (const t of ['whatsapp', 'signal', 'matrix', 'unknown']) {
                expect(isReminderSupportedChannelType(t)).toBe(false)
            }
        })
    })
})
