// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for the Claude Max subscription transport (`anthropic_subscription`).
 * Covers token sourcing, header rewrite (Bearer not x-api-key), the required
 * Claude Code identity system-block injection (preserving caller intent), the
 * fixed-string error that never leaks the token, the no-parse fast path, and
 * that a 401 classifies as `auth`.
 *
 * No live token is used anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    buildSubscriptionFetch,
    CLAUDE_CODE_SYSTEM_IDENTITY,
    isOAuthToken,
    resolveSubscriptionToken,
} from '../subscription-fetch'
import { classifyError } from '../router-v2/error-classifier'
import { buildModel, isBuiltinProviderKey, type WorkspaceAISettings } from '../registry'
import { discoverModels } from '../discover-models'

const FAKE = 'sk-ant-oat00-FAKEFAKEFAKEFAKEFAKEFAKEFAKE00'

describe('resolveSubscriptionToken', () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN
    afterEach(() => {
        if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev
    })

    it('prefers an explicit config token', () => {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token'
        expect(resolveSubscriptionToken('cfg-token')).toBe('cfg-token')
    })

    it('falls back to the environment', () => {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token'
        expect(resolveSubscriptionToken()).toBe('env-token')
    })

    it('throws when absent, without echoing any token', () => {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        expect(() => resolveSubscriptionToken()).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/)
    })

    it('recognizes oat tokens', () => {
        expect(isOAuthToken(FAKE)).toBe(true)
        expect(isOAuthToken('sk-ant-api03-x')).toBe(false)
    })
})

describe('buildSubscriptionFetch — header rewrite', () => {
    let captured: { url: unknown; init: RequestInit } | undefined
    const base = vi.fn(async (url: unknown, init: RequestInit) => {
        captured = { url, init }
        return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    beforeEach(() => {
        captured = undefined
    })

    it('uses Bearer auth and strips x-api-key', async () => {
        const f = buildSubscriptionFetch(FAKE, base)
        await f('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': FAKE, 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [] }),
        })
        const h = captured!.init.headers as Headers
        expect(h.get('authorization')).toBe(`Bearer ${FAKE}`)
        expect(h.get('x-api-key')).toBeNull()
        expect(h.get('anthropic-beta')).toContain('oauth-2025-04-20')
        expect(h.get('user-agent')).toContain('claude-cli/')
    })

    it('does not duplicate the oauth beta when already present', async () => {
        const f = buildSubscriptionFetch(FAKE, base)
        await f('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'anthropic-beta': 'oauth-2025-04-20' },
            body: '{}',
        })
        const h = captured!.init.headers as Headers
        expect(h.get('anthropic-beta')).toBe('oauth-2025-04-20')
    })
})

describe('buildSubscriptionFetch — system identity injection', () => {
    let body: unknown
    const base = vi.fn(async (_url: unknown, init: RequestInit) => {
        body = init.body ? JSON.parse(init.body as string) : undefined
        return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const f = buildSubscriptionFetch(FAKE, base)

    it('injects identity as the first block when system is absent', async () => {
        await f('u', { body: JSON.stringify({ messages: [] }) })
        expect((body as any).system[0].text).toBe(CLAUDE_CODE_SYSTEM_IDENTITY)
    })

    it('preserves a caller string system verbatim at index 1', async () => {
        await f('u', { body: JSON.stringify({ system: 'CALLER PROMPT', messages: [] }) })
        const sys = (body as any).system
        expect(sys[0].text).toBe(CLAUDE_CODE_SYSTEM_IDENTITY)
        expect(sys[1].text).toBe('CALLER PROMPT')
    })

    it('preserves caller system blocks verbatim (array form)', async () => {
        await f('u', {
            body: JSON.stringify({
                system: [{ type: 'text', text: 'BLOCK A' }, { type: 'text', text: 'BLOCK B' }],
                messages: [],
            }),
        })
        const sys = (body as any).system
        expect(sys.map((b: any) => b.text)).toEqual([
            CLAUDE_CODE_SYSTEM_IDENTITY, 'BLOCK A', 'BLOCK B',
        ])
    })

    it('is idempotent — does not double-inject when identity is already first', async () => {
        await f('u', {
            body: JSON.stringify({
                system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY }, { type: 'text', text: 'X' }],
                messages: [],
            }),
        })
        const sys = (body as any).system
        expect(sys.filter((b: any) => b.text === CLAUDE_CODE_SYSTEM_IDENTITY)).toHaveLength(1)
    })
})

describe('buildSubscriptionFetch — token safety', () => {
    it('throws a fixed-string error with no token on a malformed body', async () => {
        const base = vi.fn(async () => new Response('{}')) as unknown as typeof globalThis.fetch
        const f = buildSubscriptionFetch(FAKE, base)
        // Non-JSON string body, identity absent → parse throws → caught.
        let err: Error | undefined
        try {
            await f('u', { body: 'not json {{{' })
        } catch (e) {
            err = e as Error
        }
        expect(err).toBeDefined()
        expect(err!.message).toBe('oauth_subscription_request_rewrite_failed')
        expect(err!.message).not.toContain(FAKE)
        expect(err!.stack ?? '').not.toContain(FAKE)
        expect(base).not.toHaveBeenCalled()
    })
})

describe('registry wiring', () => {
    const settings = { providers: {} } as unknown as WorkspaceAISettings

    it('registers anthropic_subscription as a builtin key', () => {
        expect(isBuiltinProviderKey('anthropic_subscription')).toBe(true)
    })

    it('builds a model from a config token', () => {
        const m = buildModel('anthropic_subscription', { provider: 'anthropic_subscription', apiKey: FAKE }, 'planning', settings)
        expect(m).toBeDefined()
        expect(String((m as any).modelId)).toContain('claude')
    })

    it('throws when no token is available', () => {
        const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        try {
            expect(() => buildModel('anthropic_subscription', { provider: 'anthropic_subscription' }, 'planning', settings)).toThrow(/OAuth token/)
        } finally {
            if (prev !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prev
        }
    })
})

describe('BYOK discovery wiring', () => {
    it('returns the static Claude catalog without a network call (oat cannot list models)', async () => {
        const r = await discoverModels('anthropic_subscription', {})
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.fallbackModels).toContain('claude-sonnet-4-5')
            expect(r.fallbackModels.length).toBeGreaterThan(0)
        }
    })
})

describe('401 token-expiry classification', () => {
    it('classifies an Anthropic authentication_error as auth + surfaces badge', () => {
        const c = classifyError(new Error('AI_APICallError: 401 {"type":"authentication_error"}'))
        expect(c.class).toBe('auth')
        expect(c.shouldFallback).toBe(true)
        expect(c.suggestedAction).toBe('surface-auth-badge')
    })
})
