// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase I Stage 2 (post-audit) — pre-flight model-compat validation tests.
 *
 * Mounts `provider-instances` router on a tiny express instance, drives
 * PATCH /:instanceId via fetch, and asserts that:
 *   1. PATCH that changes selectedModel triggers a synthetic generateObject
 *      call via the validate-compat helper
 *   2. Native success → row gets model_compat_status='native'
 *   3. Repair success → 'repair'
 *   4. Total failure → 'failed' with validated_at still set
 *   5. PATCH itself succeeds (200) even when the synthetic call throws
 *   6. PATCH that does NOT change selectedModel does not run validation
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    instanceRow: null as any,
    updateCalls: [] as any[],
    validateCalls: 0,
    validateImpl: null as null | ((id: string, opts: any) => Promise<any>),
    decryptCalls: 0,
}

vi.mock('@plexo/agent/providers/instances', () => ({
    getProvider: vi.fn(async (_id: string) => ctl.instanceRow),
    updateProvider: vi.fn(async (id: string, updates: any) => {
        ctl.updateCalls.push({ id, updates })
        // Simulate the persisted row reflecting the latest updates +
        // any compat columns the validator wrote.
        ctl.instanceRow = { ...ctl.instanceRow, ...updates }
        return ctl.instanceRow
    }),
    listProviders: vi.fn(async () => []),
    addProvider: vi.fn(),
    removeProvider: vi.fn(),
    reorderProviders: vi.fn(),
    refreshInstanceCapabilities: vi.fn(),
    refreshWorkspaceCapabilities: vi.fn(),
    seedManagedProvider: vi.fn(),
}))

vi.mock('@plexo/agent/providers/migrate-to-instances', () => ({
    needsMigration: vi.fn(async () => false),
    migrateWorkspaceProviders: vi.fn(),
}))

vi.mock('@plexo/agent/providers/validate-compat', () => ({
    validateProviderInstanceCompat: vi.fn(async (id: string, opts: any) => {
        ctl.validateCalls++
        if (ctl.validateImpl) return ctl.validateImpl(id, opts)
        return { status: 'native', latencyMs: 100, model: 'test-model', message: 'ok' }
    }),
}))

vi.mock('../../crypto.js', () => ({
    decrypt: vi.fn((_cipher: string, _ws: string) => {
        ctl.decryptCalls++
        return 'sk-test-key'
    }),
    encrypt: vi.fn((plain: string, _ws: string) => `enc:${plain}`),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.updateCalls = []
    ctl.validateCalls = 0
    ctl.validateImpl = null
    ctl.decryptCalls = 0
    ctl.instanceRow = {
        id: 'inst-1',
        workspaceId: 'ws-1',
        nickname: 'Test',
        providerType: 'openai',
        endpointUrl: null,
        encryptedKey: 'enc:sk-test',
        selectedModel: 'gpt-4o',
        capabilities: {},
        preferenceOrder: 0,
        managed: false,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastDiscoveredAt: null,
        modelCompatStatus: null,
        modelCompatValidatedAt: null,
    }

    if (!server) {
        const { providerInstancesRouter } = await import('../provider-instances.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/workspaces/:id/providers', providerInstancesRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => {
    if (server) server.close()
})

describe('PATCH /:instanceId — pre-flight model-compat validation', () => {
    it('records native compat when synthetic call succeeds without repair', async () => {
        ctl.validateImpl = async () => ({ status: 'native', latencyMs: 250, model: 'gpt-4o-mini', message: 'native ok' })

        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedModel: 'gpt-4o-mini' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.compat?.status).toBe('native')
        expect(body.compat?.message).toBe('native ok')
        expect(ctl.validateCalls).toBe(1)
        expect(ctl.decryptCalls).toBe(1)
    })

    it('records repair compat when synthetic call goes through repair path', async () => {
        ctl.validateImpl = async () => ({ status: 'repair', latencyMs: 600, model: 'llama-3.3', message: 'used repair wrapper' })

        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedModel: 'llama-3.3' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.compat?.status).toBe('repair')
    })

    it('records failed compat when synthetic call totally fails', async () => {
        ctl.validateImpl = async () => ({ status: 'failed', latencyMs: 1200, model: 'broken-model', message: 'CALL_MODEL_4XX: 401 Unauthorized' })

        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedModel: 'broken-model' }),
        })
        // PATCH succeeds even on compat failure — the user shouldn't be
        // locked out of changing settings just because the model is bad.
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.compat?.status).toBe('failed')
        expect(body.compat?.message).toContain('CALL_MODEL_4XX')
    })

    it('does not block the PATCH when the synthetic test throws', async () => {
        ctl.validateImpl = async () => { throw new Error('catastrophic') }

        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedModel: 'whatever' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        // No compat field when validation errored — frontend just skips the badge.
        expect(body.compat).toBeUndefined()
    })

    it('skips validation when selectedModel is unchanged', async () => {
        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: 'Renamed' }),
        })
        expect(res.status).toBe(200)
        expect(ctl.validateCalls).toBe(0)
    })

    it('skips validation when the same model is reselected', async () => {
        // Instance already has gpt-4o; sending the same value is a no-op.
        const res = await fetch(`${baseUrl}/api/v1/workspaces/ws-1/providers/inst-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedModel: 'gpt-4o' }),
        })
        expect(res.status).toBe(200)
        expect(ctl.validateCalls).toBe(0)
    })
})
