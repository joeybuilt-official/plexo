// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §3) — loop-closer pin.
 *
 * POST /api/v1/agents/run must stamp the dispatching app's identity
 * (req.serviceContext.appId) into the queued task's context, so the executor
 * (agent-loop buildTaskContext) can read ctx.appId for per-(app×workspace)
 * capability enforcement. Anti-spoof: a client-supplied context.appId must be
 * overridden by the service-key context, never trusted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    pushed: [] as Array<Record<string, unknown>>,
    serviceAppId: undefined as string | undefined,
}

vi.mock('@plexo/queue', () => ({
    push: async (params: Record<string, unknown>) => {
        ctl.pushed.push(params)
        return 'task-id-123'
    },
}))

vi.mock('@plexo/db', () => {
    const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => [{ id: '11111111-1111-4111-8111-111111111111' }],
    }
    return {
        db: { select: () => chain },
        eq: () => ({}),
        workspaces: { id: 'workspaces.id', ownerId: 'workspaces.owner_id' },
    }
})

const USER_ID = '22222222-2222-4222-8222-222222222222'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { agentsRunRouter } = await import('../agents-run.js')
        const app = express()
        app.use(express.json())
        // Stand in for requireAuth → tryAppServiceKeyAuth, which sets serviceContext.
        app.use((req, _res, next) => {
            if (ctl.serviceAppId) req.serviceContext = { appId: ctl.serviceAppId }
            next()
        })
        app.use('/api/v1/agents', agentsRunRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

async function run(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = await getServer()
    const res = await fetch(`${url}/api/v1/agents/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID },
        body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() as Record<string, unknown> }
}

describe('POST /api/v1/agents/run — appId stamping (ADR 0001 §3)', () => {
    beforeEach(() => {
        ctl.pushed = []
        ctl.serviceAppId = undefined
    })

    it('stamps context.appId from the service-key context', async () => {
        ctl.serviceAppId = 'levio'
        const { status } = await run({ agentId: 'triage', context: { foo: 'bar' } })
        expect(status).toBe(201)
        expect(ctl.pushed).toHaveLength(1)
        const ctx = ctl.pushed[0]!.context as Record<string, unknown>
        expect(ctx.appId).toBe('levio')
        expect(ctx.agentId).toBe('triage')
        expect(ctx.foo).toBe('bar')
    })

    it('overrides a client-supplied context.appId (anti-spoof)', async () => {
        ctl.serviceAppId = 'levio'
        await run({ agentId: 'triage', context: { appId: 'frame-forge' } })
        const ctx = ctl.pushed[0]!.context as Record<string, unknown>
        expect(ctx.appId).toBe('levio')
    })

    it('leaves appId absent when no service-key context is present', async () => {
        ctl.serviceAppId = undefined
        await run({ agentId: 'triage' })
        const ctx = ctl.pushed[0]!.context as Record<string, unknown>
        expect(ctx.appId).toBeUndefined()
    })
})
