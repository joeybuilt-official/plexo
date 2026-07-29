// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    TRIAL_DURATION_DAYS,
    quarantineNamespace,
    parseQuarantineNamespace,
    trialEndsAt,
    isInTrial,
    evaluatePromotion,
} from '../quarantine.js'

const WS = '00000000-0000-0000-0000-000000000001'

describe('quarantine namespace', () => {
    it('formats `quarantine:<ws>:<extId>`', () => {
        expect(quarantineNamespace(WS, 'fonto-attachments')).toBe(`quarantine:${WS}:fonto-attachments`)
    })

    it('rejects extIds with disallowed characters', () => {
        expect(() => quarantineNamespace(WS, 'has spaces')).toThrow()
        expect(() => quarantineNamespace(WS, 'colon:bad')).toThrow()
    })

    it('round-trips: parseQuarantineNamespace recovers (workspaceId, extId)', () => {
        const ns = quarantineNamespace(WS, 'fonto-attachments')
        expect(parseQuarantineNamespace(ns)).toEqual({ workspaceId: WS, extId: 'fonto-attachments' })
    })

    it('parse returns null for non-quarantine strings', () => {
        expect(parseQuarantineNamespace('just-a-namespace')).toBeNull()
        expect(parseQuarantineNamespace(`quarantine:${WS}`)).toBeNull()
    })
})

describe('trial duration', () => {
    it('signed → 0 days; isInTrial = false immediately', () => {
        expect(TRIAL_DURATION_DAYS.signed).toBe(0)
        const joinedAt = new Date('2026-05-09T00:00:00Z')
        expect(trialEndsAt('signed', joinedAt).getTime()).toBe(joinedAt.getTime())
        expect(isInTrial('signed', joinedAt, joinedAt)).toBe(false)
    })

    it('unverified → 7 days', () => {
        expect(TRIAL_DURATION_DAYS.unverified).toBe(7)
        const joinedAt = new Date('2026-05-09T00:00:00Z')
        const halfway = new Date('2026-05-12T00:00:00Z')
        const past = new Date('2026-05-17T00:00:00Z')
        expect(isInTrial('unverified', joinedAt, halfway)).toBe(true)
        expect(isInTrial('unverified', joinedAt, past)).toBe(false)
    })

    it('new → 30 days', () => {
        expect(TRIAL_DURATION_DAYS.new).toBe(30)
        const joinedAt = new Date('2026-01-01T00:00:00Z')
        const day29 = new Date('2026-01-30T00:00:00Z')
        const day31 = new Date('2026-02-01T00:00:00Z')
        expect(isInTrial('new', joinedAt, day29)).toBe(true)
        expect(isInTrial('new', joinedAt, day31)).toBe(false)
    })
})

describe('evaluatePromotion (stub)', () => {
    it('returns "wait" for all tiers — Pex framework wires the real signals later', () => {
        const joinedAt = new Date('2026-05-09T00:00:00Z')
        expect(evaluatePromotion({ tier: 'signed', joinedAt })).toBe('wait')
        expect(evaluatePromotion({ tier: 'unverified', joinedAt })).toBe('wait')
        expect(evaluatePromotion({ tier: 'new', joinedAt })).toBe('wait')
    })
})
