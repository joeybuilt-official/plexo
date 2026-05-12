// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { filterChannelConfigForPatch } from '../../lib/channel-config-allowlist.js'

describe('filterChannelConfigForPatch (L3.5)', () => {
    describe('per-type allow-lists', () => {
        it('twilio: allows accountSid + authToken + fromNumber', () => {
            const r = filterChannelConfigForPatch('twilio', {
                accountSid: 'AC' + 'a'.repeat(32),
                authToken: 'secret',
                fromNumber: '+15551234567',
            })
            expect(r.ok).toBe(true)
            if (r.ok) expect(Object.keys(r.filtered).sort()).toEqual(['accountSid', 'authToken', 'fromNumber'])
        })

        it('telegram: allows token + bot_token', () => {
            const r = filterChannelConfigForPatch('telegram', { token: 'newtok' })
            expect(r.ok).toBe(true)
        })

        it('gmail: REJECTS any config key (identity binding fixed at create)', () => {
            const r = filterChannelConfigForPatch('gmail', { installedConnectionId: 'whatever' })
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.error.code).toBe('CONFIG_KEY_NOT_ALLOWED')
        })

        it('whatsapp / signal / matrix (dead-UI): no allow-list keys', () => {
            for (const t of ['whatsapp', 'signal', 'matrix']) {
                const r = filterChannelConfigForPatch(t, { anything: 'value' })
                expect(r.ok).toBe(false)
            }
        })

        it('unknown channel type: defaults to empty allow-list (deny-all)', () => {
            const r = filterChannelConfigForPatch('made_up_type', { foo: 'bar' })
            expect(r.ok).toBe(false)
        })
    })

    describe('server-managed key rejection (always rejected)', () => {
        it('rejects lastHistoryId on Gmail PATCH', () => {
            const r = filterChannelConfigForPatch('gmail', { lastHistoryId: '999' })
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.error.code).toBe('CONFIG_KEY_SERVER_MANAGED')
        })

        it('rejects errorCount on any channel type', () => {
            const r = filterChannelConfigForPatch('telegram', { errorCount: 0 })
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.error.code).toBe('CONFIG_KEY_SERVER_MANAGED')
        })

        it('rejects lastError + lastErrorAt + snake_case variants', () => {
            for (const k of ['lastError', 'last_error', 'lastErrorAt', 'last_error_at', 'last_history_id', 'error_count']) {
                const r = filterChannelConfigForPatch('twilio', { [k]: 'x' })
                expect(r.ok).toBe(false)
                if (!r.ok) expect(r.error.code).toBe('CONFIG_KEY_SERVER_MANAGED')
            }
        })

        it('server-managed key is rejected even if it would otherwise be in the type allow-list (defense-in-depth)', () => {
            const r = filterChannelConfigForPatch('twilio', { accountSid: 'AC' + 'a'.repeat(32), errorCount: 99 })
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.error.code).toBe('CONFIG_KEY_SERVER_MANAGED')
        })
    })

    describe('IDOR-style attempts on Gmail', () => {
        it('cannot rebind installedConnectionId via PATCH', () => {
            const r = filterChannelConfigForPatch('gmail', { installedConnectionId: '00000000-0000-0000-0000-000000000000' })
            expect(r.ok).toBe(false)
        })

        it('cannot change emailAddress via PATCH', () => {
            const r = filterChannelConfigForPatch('gmail', { emailAddress: 'attacker@victim.com' })
            expect(r.ok).toBe(false)
        })
    })

    describe('empty / partial config', () => {
        it('empty config: filtered is empty + ok', () => {
            const r = filterChannelConfigForPatch('twilio', {})
            expect(r.ok).toBe(true)
            if (r.ok) expect(r.filtered).toEqual({})
        })
    })
})
