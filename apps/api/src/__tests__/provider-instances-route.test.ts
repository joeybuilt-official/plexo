// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP route tests for the BYOK provider-instances routes.
 *
 * Pins (BYOK-409 dead-end fix + in-place key rotation):
 *   1. POST new cloud provider → 200, inserts via addProvider
 *   2. POST duplicate of an ENABLED instance → 409 (unchanged contract)
 *   3. POST duplicate of a DISABLED instance → 200 revived:true — re-enables
 *      + replaces the key in place instead of dead-ending (the disabled row
 *      is invisible in the settings UI, so "edit the existing one" was
 *      impossible advice)
 *   4. POST revive without a key keeps the stored key (no encryptedKey update)
 *   5. POST ignores managed instances in the duplicate check
 *   6. PATCH { apiKey } encrypts + stores the replacement key (rotation)
 *   7. PATCH rotation warns (but still saves) when the smoke test fails
 *   8. PATCH cannot inject encryptedKey (or other columns) via the body
 *   9. PATCH without apiKey never touches encryptedKey and skips the smoke test
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

interface FakeInstance {
    id: string
    workspaceId: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    managed: boolean
    enabled: boolean
    selectedModel: string | null
}

const ctl: {
    existing: FakeInstance[]
    addProviderCalls: Array<Record<string, unknown>>
    updateProviderCalls: Array<{ instanceId: string; updates: Record<string, unknown> }>
    testProviderCalls: Array<{ providerKey: string; opts: Record<string, unknown> }>
    testProviderResult: { ok: boolean; message?: string }
} = {
    existing: [],
    addProviderCalls: [],
    updateProviderCalls: [],
    testProviderCalls: [],
    testProviderResult: { ok: true },
}

function fakeInstance(overrides: Partial<FakeInstance> = {}): FakeInstance {
    return {
        id: 'inst-1',
        workspaceId: 'ws-1',
        nickname: 'Cerebras',
        providerType: 'cerebras',
        endpointUrl: null,
        encryptedKey: 'enc:old-key',
        managed: false,
        enabled: true,
        selectedModel: 'gpt-oss-120b',
        ...overrides,
    }
}

vi.mock('@plexo/agent/providers/instances', () => ({
    listProviders: async () => ctl.existing,
    getProvider: async (id: string) => ctl.existing.find(p => p.id === id) ?? null,
    addProvider: async (workspaceId: string, input: Record<string, unknown>) => {
        ctl.addProviderCalls.push({ workspaceId, ...input })
        return fakeInstance({ id: 'inst-new', encryptedKey: (input.encryptedKey as string | null) ?? null })
    },
    updateProvider: async (instanceId: string, updates: Record<string, unknown>) => {
        ctl.updateProviderCalls.push({ instanceId, updates })
        const row = ctl.existing.find(p => p.id === instanceId)
        if (!row) return null
        return { ...row, ...updates }
    },
    refreshInstanceCapabilities: async () => ({}),
}))

vi.mock('@plexo/agent/providers/registry', () => ({
    isKnownProviderKey: (key: string) => key !== 'not-a-provider',
    testProvider: async (providerKey: string, opts: Record<string, unknown>) => {
        ctl.testProviderCalls.push({ providerKey, opts })
        return { ...ctl.testProviderResult, latencyMs: 1, model: (opts.model as string) ?? 'default' }
    },
}))

vi.mock('@plexo/agent/providers/validate-compat', () => ({
    validateProviderInstanceCompat: async () => ({ status: 'native', latencyMs: 1, model: 'm', message: 'ok' }),
}))

vi.mock('../crypto.js', () => ({
    encrypt: (plaintext: string, workspaceId: string) => `enc:test:${workspaceId}:${plaintext}`,
    decrypt: (ciphertext: string) => ciphertext.replace(/^enc:test:[^:]+:/, ''),
}))

vi.mock('../lib/ssrf-guard.js', () => ({
    resolveAndCheckSSRFSafe: async () => ({ ok: true }),
}))

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { providerInstancesRouter } = await import('../routes/provider-instances.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/workspaces/:id/providers', providerInstancesRouter)

        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    ctl.existing = []
    ctl.addProviderCalls = []
    ctl.updateProviderCalls = []
    ctl.testProviderCalls = []
    ctl.testProviderResult = { ok: true }
})

afterAll(() => { server?.close() })

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const base = await getServer()
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
}

async function patch(path: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const base = await getServer()
    const res = await fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
}

describe('POST /api/v1/workspaces/:id/providers', () => {
    it('1. new cloud provider → 200, inserted via addProvider', async () => {
        const { status, json } = await post('/api/v1/workspaces/ws-1/providers', {
            nickname: 'Cerebras', providerType: 'cerebras', apiKey: 'csk-fresh',
        })
        expect(status).toBe(200)
        expect(json.ok).toBe(true)
        expect(json.revived).toBeUndefined()
        expect(ctl.addProviderCalls).toHaveLength(1)
        expect(ctl.addProviderCalls[0]!.encryptedKey).toBe('enc:test:ws-1:csk-fresh')
        expect(ctl.updateProviderCalls).toHaveLength(0)
    })

    it('2. duplicate of an ENABLED instance → 409', async () => {
        ctl.existing = [fakeInstance({ enabled: true })]
        const { status, json } = await post('/api/v1/workspaces/ws-1/providers', {
            nickname: 'Cerebras', providerType: 'cerebras', apiKey: 'csk-fresh',
        })
        expect(status).toBe(409)
        expect(json.error).toMatch(/already added/)
        expect(ctl.addProviderCalls).toHaveLength(0)
        expect(ctl.updateProviderCalls).toHaveLength(0)
    })

    it('3. duplicate of a DISABLED instance → 200 revived, re-enabled with the new key', async () => {
        ctl.existing = [fakeInstance({ enabled: false })]
        const { status, json } = await post('/api/v1/workspaces/ws-1/providers', {
            nickname: 'Cerebras', providerType: 'cerebras', apiKey: 'csk-fresh',
        })
        expect(status).toBe(200)
        expect(json.ok).toBe(true)
        expect(json.revived).toBe(true)
        expect(json.provider.encryptedKey).toBe('__configured__')
        expect(ctl.addProviderCalls).toHaveLength(0)
        expect(ctl.updateProviderCalls).toHaveLength(1)
        expect(ctl.updateProviderCalls[0]!.instanceId).toBe('inst-1')
        expect(ctl.updateProviderCalls[0]!.updates).toMatchObject({
            enabled: true,
            encryptedKey: 'enc:test:ws-1:csk-fresh',
        })
        // Smoke test runs against the instance's selected model, not the
        // registry default.
        expect(ctl.testProviderCalls).toHaveLength(1)
        expect(ctl.testProviderCalls[0]!.opts.model).toBe('gpt-oss-120b')
    })

    it('4. revive without a key keeps the stored key', async () => {
        ctl.existing = [fakeInstance({ enabled: false })]
        const { status, json } = await post('/api/v1/workspaces/ws-1/providers', {
            nickname: 'Cerebras', providerType: 'cerebras',
        })
        expect(status).toBe(200)
        expect(json.revived).toBe(true)
        expect(ctl.updateProviderCalls[0]!.updates.enabled).toBe(true)
        expect(ctl.updateProviderCalls[0]!.updates).not.toHaveProperty('encryptedKey')
    })

    it('5. managed instances are ignored by the duplicate check', async () => {
        ctl.existing = [fakeInstance({ managed: true, enabled: true })]
        const { status } = await post('/api/v1/workspaces/ws-1/providers', {
            nickname: 'Cerebras', providerType: 'cerebras', apiKey: 'csk-fresh',
        })
        expect(status).toBe(200)
        expect(ctl.addProviderCalls).toHaveLength(1)
    })
})

describe('PATCH /api/v1/workspaces/:id/providers/:instanceId', () => {
    it('6. { apiKey } encrypts and stores the replacement key', async () => {
        ctl.existing = [fakeInstance()]
        const { status, json } = await patch('/api/v1/workspaces/ws-1/providers/inst-1', {
            apiKey: 'csk-rotated',
        })
        expect(status).toBe(200)
        expect(json.ok).toBe(true)
        expect(json.warning).toBeUndefined()
        expect(json.provider.encryptedKey).toBe('__configured__')
        expect(ctl.updateProviderCalls).toHaveLength(1)
        expect(ctl.updateProviderCalls[0]!.updates).toEqual({
            encryptedKey: 'enc:test:ws-1:csk-rotated',
        })
        expect(ctl.testProviderCalls).toHaveLength(1)
        expect(ctl.testProviderCalls[0]!.opts.apiKey).toBe('csk-rotated')
        expect(ctl.testProviderCalls[0]!.opts.model).toBe('gpt-oss-120b')
    })

    it('7. rotation smoke-test failure → key saved with a warning', async () => {
        ctl.existing = [fakeInstance()]
        ctl.testProviderResult = { ok: false, message: 'nope' }
        const { status, json } = await patch('/api/v1/workspaces/ws-1/providers/inst-1', {
            apiKey: 'csk-rotated',
        })
        expect(status).toBe(200)
        expect(json.ok).toBe(true)
        expect(json.warning).toMatch(/^Key saved/)
        expect(ctl.updateProviderCalls).toHaveLength(1)
    })

    it('8. body cannot inject encryptedKey directly', async () => {
        ctl.existing = [fakeInstance()]
        const { status } = await patch('/api/v1/workspaces/ws-1/providers/inst-1', {
            nickname: 'Renamed', encryptedKey: 'enc:evil',
        })
        expect(status).toBe(200)
        expect(ctl.updateProviderCalls).toHaveLength(1)
        expect(ctl.updateProviderCalls[0]!.updates).toEqual({ nickname: 'Renamed' })
    })

    it('9. no apiKey → encryptedKey untouched, no smoke test', async () => {
        ctl.existing = [fakeInstance()]
        const { status } = await patch('/api/v1/workspaces/ws-1/providers/inst-1', {
            enabled: false,
        })
        expect(status).toBe(200)
        expect(ctl.updateProviderCalls[0]!.updates).toEqual({ enabled: false })
        expect(ctl.testProviderCalls).toHaveLength(0)
    })
})
