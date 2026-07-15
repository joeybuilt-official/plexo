// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { tierAllows, tierAtLeast, eventKindMinTier } from './tiers'
import { verifyClaims, type DeviceTokenClaims, type RevocationStore } from './token'
import { killGuard } from './kill-switch'
import { evaluatePolicy, type PolicyRule } from './policy'

// ── Tier matrix ─────────────────────────────────────────────────

describe('tier matrix', () => {
    it('observe is read-only — blocks mutation', () => {
        expect(tierAllows('observe', 'read')).toBe(true)
        expect(tierAllows('observe', 'message')).toBe(false)
        expect(tierAllows('observe', 'mutate')).toBe(false)
    })
    it('steer can message/approve but not mutate', () => {
        expect(tierAllows('steer', 'message')).toBe(true)
        expect(tierAllows('steer', 'approve')).toBe(true)
        expect(tierAllows('steer', 'mutate')).toBe(false)
    })
    it('drive allows mutation', () => {
        expect(tierAllows('drive', 'mutate')).toBe(true)
        expect(tierAtLeast('drive', 'steer')).toBe(true)
        expect(tierAtLeast('observe', 'steer')).toBe(false)
    })
    it('maps event kinds to a minimum tier', () => {
        expect(eventKindMinTier('message')).toBe('steer')
        expect(eventKindMinTier('approval_decision')).toBe('steer')
        expect(eventKindMinTier('tool_call')).toBe('drive')
        expect(eventKindMinTier('outcome')).toBe('drive')
    })
})

// ── verifyClaims ────────────────────────────────────────────────

const NOW = 1_000_000
const validClaims: DeviceTokenClaims = {
    deviceId: 'dev-1',
    participantId: 'part-1',
    workspaceId: 'ws-1',
    tier: 'drive',
    jti: 'jti-1',
    iat: NOW - 60,
    exp: NOW + 900,
}

describe('verifyClaims', () => {
    it('accepts a well-formed, unexpired token', () => {
        const r = verifyClaims(validClaims, NOW)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.claims.jti).toBe('jti-1')
    })
    it('rejects an expired token', () => {
        const r = verifyClaims({ ...validClaims, exp: NOW - 1 }, NOW)
        expect(r).toEqual({ ok: false, reason: 'expired' })
    })
    it('rejects a malformed payload', () => {
        expect(verifyClaims({ deviceId: 'x' }, NOW)).toEqual({ ok: false, reason: 'malformed' })
        expect(verifyClaims({ ...validClaims, tier: 'god' }, NOW)).toEqual({ ok: false, reason: 'malformed' })
        expect(verifyClaims(null, NOW)).toEqual({ ok: false, reason: 'malformed' })
    })
})

// ── Kill switch ─────────────────────────────────────────────────

describe('killGuard', () => {
    it('allows when disengaged', () => {
        expect(killGuard({ engaged: false })).toEqual({ allow: true })
    })
    it('blocks when engaged, surfacing the reason', () => {
        expect(killGuard({ engaged: true, reason: 'incident-42' })).toEqual({ allow: false, reason: 'incident-42' })
        expect(killGuard({ engaged: true })).toEqual({ allow: false, reason: 'kill-switch engaged' })
    })
})

// ── Revocation (mock store) ─────────────────────────────────────

class InMemoryRevocations implements RevocationStore {
    private set = new Map<string, number>()
    async revoke(jti: string, expiresAtSec: number): Promise<void> {
        this.set.set(jti, expiresAtSec)
    }
    async isRevoked(jti: string): Promise<boolean> {
        return this.set.has(jti)
    }
}

describe('revocation logic', () => {
    it('flags a jti only after it is revoked', async () => {
        const store = new InMemoryRevocations()
        expect(await store.isRevoked('jti-1')).toBe(false)
        await store.revoke('jti-1', NOW + 900)
        expect(await store.isRevoked('jti-1')).toBe(true)
        expect(await store.isRevoked('jti-2')).toBe(false)
    })
})

// ── Policy evaluation ───────────────────────────────────────────

const rules: PolicyRule[] = [
    { id: 'deny-rm', match: { tool: 'bash', cmd_pattern: '\\brm\\s+-rf\\b' }, decision: 'deny', teach: 'no rm -rf' },
    { id: 'gate-push', match: { tool: 'bash', cmd_pattern: '\\bgit\\s+push\\b' }, tier: 'drive', decision: 'gate', teach: 'push needs drive' },
    { id: 'gate-edit', match: { path_glob: 'src/**/*.ts' }, tier: 'drive', decision: 'allow', teach: 'edit needs drive' },
]

describe('evaluatePolicy', () => {
    it('denies a risky command with a teach string', () => {
        const r = evaluatePolicy({ tool: 'bash', cmd: 'rm -rf /' }, 'drive', rules)
        expect(r.decision).toBe('deny')
        expect(r.teach).toBe('no rm -rf')
        expect(r.ruleId).toBe('deny-rm')
    })
    it('gates git push at the rule level', () => {
        const r = evaluatePolicy({ tool: 'bash', cmd: 'git push origin main' }, 'drive', rules)
        expect(r.decision).toBe('gate')
    })
    it('downgrades an allow rule to gate when the tier is insufficient', () => {
        const r = evaluatePolicy({ path: 'src/a/b.ts' }, 'observe', rules)
        expect(r.decision).toBe('gate')
        const ok = evaluatePolicy({ path: 'src/a/b.ts' }, 'drive', rules)
        expect(ok.decision).toBe('allow')
    })
    it('allows when no rule matches', () => {
        expect(evaluatePolicy({ tool: 'bash', cmd: 'ls -la' }, 'observe', rules)).toEqual({ decision: 'allow' })
    })
    it('fails closed to gate on over-length input (ReDoS guard)', () => {
        const huge = 'a'.repeat(16_385)
        const r = evaluatePolicy({ tool: 'bash', cmd: huge }, 'drive', rules)
        expect(r.decision).toBe('gate')
    })
})
