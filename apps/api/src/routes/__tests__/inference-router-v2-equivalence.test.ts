// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3 — HTTP-level equivalence test for the inference shim's
 * chat-completions handler under both dispatch paths:
 *
 *   - ROUTER_V2_ENABLED=false  → handler dispatches via `withFallback`
 *   - ROUTER_V2_ENABLED=true   → handler dispatches via `routeAndCall`
 *
 * The HTTP response shape (status, body keys, content) MUST be identical
 * between the two paths for equivalent inputs. This freezes the contract
 * boundary before Phase 4 migrates the remaining 11 call sites.
 *
 * ADR 0012 / plan.md Phase 3.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

vi.mock('@plexo/agent/memory/store', () => ({
    embed: vi.fn(),
}))

class MockCallModelError extends Error {
    code: string
    constructor(message: string, code: string) {
        super(message)
        this.name = 'CallModelError'
        this.code = code
    }
}

vi.mock('@plexo/agent/providers/call-model', () => ({
    callModel: vi.fn(),
    CallModelError: MockCallModelError,
}))

// The shim's chat-completions handler uses `withFallback` (flag-off path)
// and `routeAndCall` (flag-on path). Mock both, plus `resolveModelFromEnv`
// which isn't reached here (settings non-null) but is imported.
const withFallbackMock = vi.fn()
const routeAndCallMock = vi.fn()
const isRouterV2EnabledMock = vi.fn(() => false)
const isRouterV2ShadowEnabledMock = vi.fn(() => false)
const runShadowCompareMock: ReturnType<typeof vi.fn> = vi.fn(async (_input: unknown): Promise<void> => undefined)

vi.mock('@plexo/agent/providers/registry', () => ({
    withFallback: (...args: unknown[]) => withFallbackMock(...args),
    resolveModelFromEnv: vi.fn(() => ({ __mock: 'env-model' })),
}))

vi.mock('@plexo/agent/providers/router-v2', () => ({
    routeAndCall: (...args: unknown[]) => routeAndCallMock(...args),
    isRouterV2Enabled: () => isRouterV2EnabledMock(),
    isRouterV2ShadowEnabled: () => isRouterV2ShadowEnabledMock(),
    runShadowCompare: (...args: unknown[]) => runShadowCompareMock(...args as Parameters<typeof runShadowCompareMock>),
}))

// A non-null settings object — handler dispatches via withFallback/routeAndCall
// only when loadSettingsFromInstances returns truthy.
const fakeSettings = { fakeSettings: true, primaryProvider: 'anthropic' }
vi.mock('@plexo/agent/providers/settings-from-instances', () => ({
    loadSettingsFromInstances: vi.fn(async () => fakeSettings),
}))

const { callModel } = await import('@plexo/agent/providers/call-model')
const { inferenceRouter } = await import('../inference.js')

const SERVICE_KEY = 'test-service-key-1234567890abcd'
const VALID_WORKSPACE = '00000000-0000-0000-0000-000000000001'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const app = express()
        app.use(express.json())
        app.use('/api/inference', inferenceRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    vi.clearAllMocks()
    // Default — both flags off; each test flips on as needed.
    isRouterV2EnabledMock.mockReturnValue(false)
    isRouterV2ShadowEnabledMock.mockReturnValue(false)
    runShadowCompareMock.mockImplementation(async () => undefined)
})

afterAll(() => { server?.close() })

function authHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': 'test-suite',
        'X-Plexo-Workspace-Id': VALID_WORKSPACE,
    }
}

const CHAT_BODY = {
    messages: [{ role: 'user', content: 'hello router' }],
}

// Both code paths receive a `doCall(model)` callback. We pass through to
// callModel so the route handler's response-shaping logic runs end-to-end.
const happyCallModelResult = {
    text: 'hi back',
    inputTokens: 7,
    outputTokens: 3,
    latencyMs: 42,
    model: 'gpt-4o-mini',
    attempts: 1,
}

function wireWithFallbackHappyPath(): void {
    withFallbackMock.mockImplementation(async (
        _settings: unknown,
        _taskType: unknown,
        fn: (model: unknown) => Promise<unknown>,
    ) => fn({ provider: 'openai' }))
}

function wireRouteAndCallHappyPath(): void {
    routeAndCallMock.mockImplementation(async (input: {
        doCall: (model: unknown) => Promise<unknown>
    }) => input.doCall({ provider: 'openai' }))
}

describe('chat/completions HTTP equivalence: withFallback ↔ routeAndCall', () => {
    it('flag-off → goes through withFallback; flag-on → goes through routeAndCall', async () => {
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        wireRouteAndCallHappyPath()

        const base = await getServer()

        // 1) Flag off
        isRouterV2EnabledMock.mockReturnValue(false)
        const res1 = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        expect(res1.status).toBe(200)
        expect(withFallbackMock).toHaveBeenCalledTimes(1)
        expect(routeAndCallMock).not.toHaveBeenCalled()

        vi.clearAllMocks()
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        wireRouteAndCallHappyPath()

        // 2) Flag on
        isRouterV2EnabledMock.mockReturnValue(true)
        const res2 = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        expect(res2.status).toBe(200)
        expect(routeAndCallMock).toHaveBeenCalledTimes(1)
        expect(withFallbackMock).not.toHaveBeenCalled()

        // Equivalence: response bodies match except for the per-call ID.
        const b1 = await res1.json() as Record<string, unknown> & { id: string }
        const b2 = await res2.json() as Record<string, unknown> & { id: string }
        expect(b1.id.startsWith('chatcmpl-')).toBe(true)
        expect(b2.id.startsWith('chatcmpl-')).toBe(true)
        const { id: _id1, created: _c1, ...rest1 } = b1
        const { id: _id2, created: _c2, ...rest2 } = b2
        expect(rest1).toEqual(rest2)
    })

    it('routeAndCall receives the same { taskType, settings, workspaceId, opts.workspaceId } the legacy path receives', async () => {
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        wireRouteAndCallHappyPath()

        const base = await getServer()

        // Flag off — capture withFallback args
        isRouterV2EnabledMock.mockReturnValue(false)
        await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        const wfCall = withFallbackMock.mock.calls[0]!
        const wfSettings = wfCall[0]
        const wfTaskType = wfCall[1]
        const wfOpts = wfCall[3] as { workspaceId?: string }

        vi.clearAllMocks()
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        wireRouteAndCallHappyPath()

        // Flag on — capture routeAndCall args
        isRouterV2EnabledMock.mockReturnValue(true)
        await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        const racInput = routeAndCallMock.mock.calls[0]![0] as {
            workspaceId?: string
            taskType: string
            settings: unknown
            opts?: { workspaceId?: string }
        }

        expect(racInput.workspaceId).toBe(VALID_WORKSPACE)
        expect(racInput.taskType).toBe(wfTaskType)
        expect(racInput.settings).toBe(wfSettings)
        expect(racInput.opts?.workspaceId).toBe(wfOpts.workspaceId)
        expect(racInput.opts?.workspaceId).toBe(VALID_WORKSPACE)
    })

    it('flag-on path surfaces CallModelError with the same status mapping as flag-off', async () => {
        // Both routes re-throw whatever doCall throws — they share the
        // CallModelError → status mapping at the handler boundary.
        const err = new MockCallModelError('timed out', 'CALL_MODEL_TIMEOUT')

        vi.mocked(callModel).mockRejectedValue(err)
        withFallbackMock.mockImplementation(async (_s, _t, fn) => fn({ provider: 'openai' }))
        routeAndCallMock.mockImplementation(async (input: { doCall: (m: unknown) => Promise<unknown> }) => input.doCall({ provider: 'openai' }))

        const base = await getServer()

        isRouterV2EnabledMock.mockReturnValue(false)
        const r1 = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        expect(r1.status).toBe(504)
        const b1 = await r1.json() as { error: { code: string } }
        expect(b1.error.code).toBe('CALL_MODEL_TIMEOUT')

        vi.clearAllMocks()
        vi.mocked(callModel).mockRejectedValue(err)
        withFallbackMock.mockImplementation(async (_s, _t, fn) => fn({ provider: 'openai' }))
        routeAndCallMock.mockImplementation(async (input: { doCall: (m: unknown) => Promise<unknown> }) => input.doCall({ provider: 'openai' }))

        isRouterV2EnabledMock.mockReturnValue(true)
        const r2 = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        expect(r2.status).toBe(504)
        const b2 = await r2.json() as { error: { code: string } }
        expect(b2.error.code).toBe(b1.error.code)
    })
})

describe('chat/completions shadow-mode (ROUTER_V2_SHADOW)', () => {
    it('(a) shadow OFF + v2 OFF → no extra calls; only withFallback runs', async () => {
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        wireRouteAndCallHappyPath()
        isRouterV2EnabledMock.mockReturnValue(false)
        isRouterV2ShadowEnabledMock.mockReturnValue(false)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        expect(res.status).toBe(200)
        expect(withFallbackMock).toHaveBeenCalledTimes(1)
        expect(routeAndCallMock).not.toHaveBeenCalled()
        expect(runShadowCompareMock).not.toHaveBeenCalled()
    })

    it('(b) shadow ON + v2 OFF → both paths run, event emitted, user served from primary', async () => {
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        // Have the shadow harness ACTUALLY call routeAndCall so we observe both paths run.
        routeAndCallMock.mockImplementation(async (input: {
            doCall: (m: unknown) => Promise<unknown>
        }) => input.doCall({ provider: 'anthropic' }))
        runShadowCompareMock.mockImplementation(async (input: {
            runShadow: () => Promise<unknown>
        }) => {
            await input.runShadow()
        })
        isRouterV2EnabledMock.mockReturnValue(false)
        isRouterV2ShadowEnabledMock.mockReturnValue(true)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        // The shadow path is fire-and-forget; settle pending microtasks so its
        // awaits complete before assertions.
        await new Promise<void>(r => setImmediate(r))
        await new Promise<void>(r => setImmediate(r))

        expect(res.status).toBe(200)
        const body = await res.json() as { choices: Array<{ message: { content: string } }> }
        expect(body.choices[0]!.message.content).toBe('hi back')

        // User-facing path: withFallback served the request.
        expect(withFallbackMock).toHaveBeenCalledTimes(1)
        // Shadow path: runShadowCompare invoked once, and within it routeAndCall ran.
        expect(runShadowCompareMock).toHaveBeenCalledTimes(1)
        expect(routeAndCallMock).toHaveBeenCalledTimes(1)

        // The shadow event payload (primary outcome) must be supplied by the handler.
        const shadowInput = runShadowCompareMock.mock.calls[0]![0] as {
            primary: { status: string; latencyMs: number }
            taskType: string
            workspaceId: string
        }
        expect(shadowInput.primary.status).toBe('ok')
        expect(typeof shadowInput.primary.latencyMs).toBe('number')
        // Handler picks 'summarization' for text mode + 'extraction' for json_schema.
        expect(shadowInput.taskType).toBe('summarization')
        expect(shadowInput.workspaceId).toBe(VALID_WORKSPACE)
    })

    it('(c) shadow path failure does NOT affect the user response', async () => {
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        // Shadow throws — but runShadowCompare in production swallows it; the
        // handler additionally attaches a .catch. Simulate the realistic case:
        // routeAndCall rejects, runShadowCompare itself does NOT throw (matches
        // production contract — see shadow.ts runShadowCompare implementation).
        routeAndCallMock.mockRejectedValue(new Error('shadow boom'))
        runShadowCompareMock.mockImplementation(async () => undefined)
        isRouterV2EnabledMock.mockReturnValue(false)
        isRouterV2ShadowEnabledMock.mockReturnValue(true)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        await new Promise<void>(r => setImmediate(r))

        // User-facing response unaffected by shadow failure.
        expect(res.status).toBe(200)
        const body = await res.json() as { choices: Array<{ message: { content: string } }> }
        expect(body.choices[0]!.message.content).toBe('hi back')
        expect(withFallbackMock).toHaveBeenCalledTimes(1)
        expect(runShadowCompareMock).toHaveBeenCalledTimes(1)
    })

    it('(c\') shadow path that throws synchronously is also swallowed', async () => {
        // Belt-and-suspenders: even if runShadowCompare itself were to reject
        // (in violation of its contract), the handler's `.catch` must prevent
        // it from corrupting the response.
        vi.mocked(callModel).mockResolvedValue(happyCallModelResult as Awaited<ReturnType<typeof callModel>>)
        wireWithFallbackHappyPath()
        runShadowCompareMock.mockRejectedValueOnce(new Error('harness exploded'))
        isRouterV2EnabledMock.mockReturnValue(false)
        isRouterV2ShadowEnabledMock.mockReturnValue(true)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(CHAT_BODY),
        })
        await new Promise<void>(r => setImmediate(r))
        await new Promise<void>(r => setImmediate(r))

        expect(res.status).toBe(200)
        const body = await res.json() as { choices: Array<{ message: { content: string } }> }
        expect(body.choices[0]!.message.content).toBe('hi back')
    })
})
