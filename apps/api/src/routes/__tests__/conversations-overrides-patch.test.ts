// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DD-5 tests: PATCH /api/v1/conversations/:id — per-conversation model +
 * system-prompt override persistence. Auth + workspace access + null handling.
 *
 * Mocks the conversations repository so no Postgres is required. The router's
 * own ensureWorkspaceAccess mock returns true; a separate case flips it to
 * assert the 403/401 path is honoured.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const WS = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const CONV_ID = '01J5TESTCONV00000000000001'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const repoMock = {
    getConversationById: vi.fn(),
    updateConversationOverrides: vi.fn(),
    listSessionTurns: vi.fn(async () => []),
    listGroupedBySession: vi.fn(async () => []),
    listFlat: vi.fn(async () => []),
    getConversationWorkspaceId: vi.fn(),
}

vi.mock('../../repositories/conversations.repository.js', () => repoMock)

const ensureWorkspaceAccess = vi.fn(async (_req: unknown, _res: unknown, _workspaceId?: string): Promise<boolean> => true)
vi.mock('../../middleware/workspace-access.js', () => ({ ensureWorkspaceAccess }))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let url = ''

async function ensureServer() {
    if (server) return
    const { conversationsRouter } = await import('../conversations.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/conversations', conversationsRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
    repoMock.getConversationById.mockReset()
    repoMock.updateConversationOverrides.mockReset()
    ensureWorkspaceAccess.mockReset()
    ensureWorkspaceAccess.mockResolvedValue(true)
})

afterAll(() => { server?.close() })

// ─────────────────────────────────────────────────────────────────────────────
// Auth + workspace access
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/conversations/:id — auth + workspace access', () => {
    it('404 when the conversation does not exist', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue(undefined)
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'openai/gpt-4o' }),
        })
        expect(res.status).toBe(404)
        const body = await res.json() as any
        expect(body.error.code).toBe('NOT_FOUND')
        expect(repoMock.updateConversationOverrides).not.toHaveBeenCalled()
    })

    it('denies when ensureWorkspaceAccess returns false', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: null, systemPromptOverride: null,
        })
        // The real middleware writes the 403 response itself; mirror that so
        // fetch resolves instead of hanging on an unended request.
        ensureWorkspaceAccess.mockImplementation(async (_req: any, res: any) => {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'denied' } })
            return false
        })
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'openai/gpt-4o' }),
        })
        // ensureWorkspaceAccess writes its own response (401/403) and the
        // handler returns early. We only assert it never reached the repo.
        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(repoMock.updateConversationOverrides).not.toHaveBeenCalled()
    })

    it('checks workspace access against the conversation\'s workspaceId, not the body', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: null, systemPromptOverride: null,
        })
        repoMock.updateConversationOverrides.mockResolvedValue({
            id: CONV_ID, workspaceId: WS, modelOverride: 'openai/gpt-4o', systemPromptOverride: null,
        })
        await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'openai/gpt-4o' }),
        })
        expect(ensureWorkspaceAccess).toHaveBeenCalledTimes(1)
        // Third arg is the workspaceId sourced from the row (req, res, wsId).
        const callArgs = ensureWorkspaceAccess.mock.calls[0] as unknown as [unknown, unknown, string]
        const workspaceIdArg = callArgs[2]
        expect(workspaceIdArg).toBe(WS)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Persistence + null handling
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/conversations/:id — persistence + null handling', () => {
    it('sets modelOverride and returns the updated row', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: null, systemPromptOverride: null,
        })
        repoMock.updateConversationOverrides.mockResolvedValue({
            id: CONV_ID, workspaceId: WS, modelOverride: 'openai/gpt-4o', systemPromptOverride: null,
        })
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'openai/gpt-4o' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.modelOverride).toBe('openai/gpt-4o')
        expect(repoMock.updateConversationOverrides).toHaveBeenCalledWith(CONV_ID, {
            modelOverride: 'openai/gpt-4o',
            systemPromptOverride: undefined,
        })
    })

    it('sets systemPromptOverride and returns the updated row', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: null, systemPromptOverride: null,
        })
        repoMock.updateConversationOverrides.mockResolvedValue({
            id: CONV_ID, workspaceId: WS, modelOverride: null, systemPromptOverride: 'Be terse.',
        })
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPromptOverride: 'Be terse.' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.systemPromptOverride).toBe('Be terse.')
        expect(repoMock.updateConversationOverrides).toHaveBeenCalledWith(CONV_ID, {
            modelOverride: undefined,
            systemPromptOverride: 'Be terse.',
        })
    })

    it('nulls a field when explicitly sent null', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: 'openai/gpt-4o', systemPromptOverride: 'Be terse.',
        })
        repoMock.updateConversationOverrides.mockResolvedValue({
            id: CONV_ID, workspaceId: WS, modelOverride: null, systemPromptOverride: 'Be terse.',
        })
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: null }),
        })
        expect(res.status).toBe(200)
        expect(repoMock.updateConversationOverrides).toHaveBeenCalledWith(CONV_ID, {
            modelOverride: null,
            systemPromptOverride: undefined,
        })
    })

    it('leaves a field untouched when omitted from the body', async () => {
        await ensureServer()
        repoMock.getConversationById.mockResolvedValue({
            id: CONV_ID, workspaceId: WS,
            modelOverride: 'openai/gpt-4o', systemPromptOverride: 'Be terse.',
        })
        // No-op update returns the existing row.
        repoMock.updateConversationOverrides.mockResolvedValue({
            id: CONV_ID, workspaceId: WS, modelOverride: 'openai/gpt-4o', systemPromptOverride: 'Be terse.',
        })
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(200)
        // With an empty body, the repo should be called with both fields undefined
        // (no-op). The handler short-circuits via getConversationById when no
        // keys are present.
        expect(repoMock.updateConversationOverrides).toHaveBeenCalledWith(CONV_ID, {
            modelOverride: undefined,
            systemPromptOverride: undefined,
        })
    })

    it('rejects id > 64 chars with INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${url}/api/v1/conversations/${'a'.repeat(65)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'openai/gpt-4o' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error.code).toBe('INVALID_ID')
        expect(repoMock.getConversationById).not.toHaveBeenCalled()
    })

    it('rejects non-string modelOverride with INVALID_BODY', async () => {
        await ensureServer()
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 42 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error.code).toBe('INVALID_BODY')
    })

    it('rejects oversized modelOverride (>256 chars) with INVALID_BODY', async () => {
        await ensureServer()
        const res = await fetch(`${url}/api/v1/conversations/${CONV_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelOverride: 'x'.repeat(257) }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error.code).toBe('INVALID_BODY')
    })
})