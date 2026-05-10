// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inference shim tests — Phase 3a of ADR 0010 / ADR 0011.
 * Pins:
 *   1. Single-string and array inputs both shape correctly to OpenAI response
 *   2. Workspace ID header required + must be UUID
 *   3. Bearer service-key auth required (delegates to requireServiceKey)
 *   4. Embedding adapter null → 502, missing input → 400, empty array → 400
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

vi.mock('@plexo/agent/providers/registry', () => ({
    resolveModel: vi.fn(),
    resolveModelFromEnv: vi.fn(() => ({ __mock: 'env-model' })),
}))

vi.mock('@plexo/agent/providers/settings-from-instances', () => ({
    loadSettingsFromInstances: vi.fn(async () => null),
}))

const { embed } = await import('@plexo/agent/memory/store')
const { callModel } = await import('@plexo/agent/providers/call-model')
const { resolveModel } = await import('@plexo/agent/providers/registry')
const { loadSettingsFromInstances } = await import('@plexo/agent/providers/settings-from-instances')
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
})

afterAll(() => { server?.close() })

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': 'test-suite',
        'X-Plexo-Workspace-Id': VALID_WORKSPACE,
        ...extra,
    }
}

describe('POST /api/inference/v1/embeddings', () => {
    it('returns OpenAI-shaped response for a single string input', async () => {
        vi.mocked(embed).mockResolvedValueOnce(new Array(256).fill(0.1))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: 'hello world', model: 'plexo-embeddings/256' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { object: string; data: Array<{ index: number; embedding: number[] }>; model: string }
        expect(body.object).toBe('list')
        expect(body.data).toHaveLength(1)
        expect(body.data[0]!.embedding).toHaveLength(256)
        expect(body.data[0]!.index).toBe(0)
        expect(body.model).toBe('plexo-embeddings/256')
        expect(embed).toHaveBeenCalledWith('hello world', VALID_WORKSPACE)
    })

    it('handles array input with one embed call per element', async () => {
        vi.mocked(embed)
            .mockResolvedValueOnce(new Array(256).fill(0.2))
            .mockResolvedValueOnce(new Array(256).fill(0.3))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: ['first', 'second'] }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
        expect(body.data).toHaveLength(2)
        expect(body.data[1]!.index).toBe(1)
        expect(embed).toHaveBeenCalledTimes(2)
    })

    it('rejects requests without X-Plexo-Workspace-Id', async () => {
        const headers = authHeaders()
        delete headers['X-Plexo-Workspace-Id']
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE_ID')
    })

    it('rejects non-UUID workspace ID', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders({ 'X-Plexo-Workspace-Id': 'not-a-uuid' }),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects requests without service-key Bearer auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(401)
    })

    it('returns 502 when the embedding adapter returns null', async () => {
        vi.mocked(embed).mockResolvedValueOnce(null)
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(502)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('EMBEDDING_PROVIDER_ERROR')
    })

    it('returns 400 on missing input', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_INPUT')
    })

    it('returns 400 on empty array input', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: [] }),
        })
        expect(res.status).toBe(400)
    })
})

describe('POST /api/inference/v1/chat/completions', () => {
    const FACT_SCHEMA = {
        type: 'object',
        properties: {
            facts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        subject: { type: 'string' },
                        predicate: { type: 'string' },
                        object: { type: 'string' },
                    },
                    required: ['subject', 'predicate', 'object'],
                    additionalProperties: false,
                },
            },
        },
        required: ['facts'],
        additionalProperties: false,
    }

    function chatBody(extra: Record<string, unknown> = {}) {
        return {
            model: 'plexo-router',
            messages: [
                { role: 'system', content: 'You extract facts.' },
                { role: 'user', content: 'User lives in Austin.' },
            ],
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'Facts', schema: FACT_SCHEMA },
            },
            ...extra,
        }
    }

    it('translates json_schema response_format → callModel({schema}) and returns OpenAI shape', async () => {
        const extracted = { facts: [{ subject: 'user', predicate: 'lives in', object: 'Austin' }] }
        vi.mocked(callModel).mockResolvedValueOnce({
            object: extracted,
            text: '',
            repairUsed: false,
            inputTokens: 50,
            outputTokens: 20,
            latencyMs: 100,
            model: 'gpt-4o-mini',
            attempts: 1,
        } as Awaited<ReturnType<typeof callModel>>)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(chatBody({ max_tokens: 256 })),
        })
        expect(res.status).toBe(200)
        const out = await res.json() as {
            id: string
            object: string
            choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
            usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
            model: string
        }
        expect(out.object).toBe('chat.completion')
        expect(out.id.startsWith('chatcmpl-')).toBe(true)
        expect(out.choices).toHaveLength(1)
        expect(out.choices[0]!.message.role).toBe('assistant')
        expect(JSON.parse(out.choices[0]!.message.content)).toEqual(extracted)
        expect(out.choices[0]!.finish_reason).toBe('stop')
        expect(out.usage).toEqual({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 })
        expect(out.model).toBe('gpt-4o-mini')

        expect(callModel).toHaveBeenCalledTimes(1)
        const opts = vi.mocked(callModel).mock.calls[0]![0]!
        expect(opts.workspaceId).toBe(VALID_WORKSPACE)
        expect(opts.system).toBe('You extract facts.')
        expect(opts.messages).toEqual([{ role: 'user', content: 'User lives in Austin.' }])
        expect(opts.maxTokens).toBe(256)
        expect(opts.schemaName).toBe('Facts')
        expect(opts.schema).toBeDefined()
        // schema parses an object matching FACT_SCHEMA — sanity check it's a real Zod schema
        const parsed = (opts.schema as { parse: (v: unknown) => unknown }).parse(extracted)
        expect(parsed).toEqual(extracted)
    })

    it('passes through to text mode (no schema) when response_format is absent', async () => {
        vi.mocked(callModel).mockResolvedValueOnce({
            text: 'plain answer',
            inputTokens: 5,
            outputTokens: 3,
            latencyMs: 50,
            model: 'gpt-4o-mini',
            attempts: 1,
        } as Awaited<ReturnType<typeof callModel>>)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
            }),
        })
        expect(res.status).toBe(200)
        const out = await res.json() as { choices: Array<{ message: { content: string } }> }
        expect(out.choices[0]!.message.content).toBe('plain answer')
        const opts = vi.mocked(callModel).mock.calls[0]![0]!
        expect(opts.schema).toBeUndefined()
    })

    it('uses workspace-resolved model when settings exist; falls through to env otherwise', async () => {
        const aiSettings = { fakeSettings: true }
        vi.mocked(loadSettingsFromInstances).mockResolvedValueOnce(aiSettings as never)
        vi.mocked(resolveModel).mockResolvedValueOnce({
            model: { __mock: 'workspace-model' } as never,
            meta: { provider: 'openai', mode: 'byok', id: 'gpt-4o', costPerMIn: 0, costPerMOut: 0 } as never,
        })
        vi.mocked(callModel).mockResolvedValueOnce({
            text: 'ok', inputTokens: 1, outputTokens: 1, latencyMs: 10, model: 'gpt-4o', attempts: 1,
        } as Awaited<ReturnType<typeof callModel>>)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        })
        expect(res.status).toBe(200)
        expect(resolveModel).toHaveBeenCalledWith('summarization', aiSettings, VALID_WORKSPACE)
        const opts = vi.mocked(callModel).mock.calls[0]![0]!
        expect((opts.model as { __mock: string }).__mock).toBe('workspace-model')
        expect(opts.provider).toBe('openai')
    })

    it('rejects requests with tools (501 — Phase 3b scope)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
            }),
        })
        expect(res.status).toBe(501)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('TOOLS_NOT_SUPPORTED')
        expect(callModel).not.toHaveBeenCalled()
    })

    it('rejects streaming requests (501)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        })
        expect(res.status).toBe(501)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('STREAMING_NOT_SUPPORTED')
    })

    it('rejects empty messages array (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ messages: [] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_MESSAGES')
    })

    it('rejects messages with only system role (no user/assistant turn) — 400', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                messages: [{ role: 'system', content: 'be helpful' }],
            }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_USER_MESSAGE')
    })

    it('rejects malformed json_schema response_format (missing schema)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                response_format: { type: 'json_schema', json_schema: { name: 'X' } },
            }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_RESPONSE_FORMAT')
    })

    it('maps CallModelError(CALL_MODEL_PARSE) → 502', async () => {
        vi.mocked(callModel).mockRejectedValueOnce(new MockCallModelError('parse failed', 'CALL_MODEL_PARSE'))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(chatBody()),
        })
        expect(res.status).toBe(502)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('CALL_MODEL_PARSE')
    })

    it('maps CallModelError(CALL_MODEL_TIMEOUT) → 504', async () => {
        vi.mocked(callModel).mockRejectedValueOnce(new MockCallModelError('timed out', 'CALL_MODEL_TIMEOUT'))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(chatBody()),
        })
        expect(res.status).toBe(504)
    })

    it('rejects requests without service-key Bearer auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(chatBody()),
        })
        expect(res.status).toBe(401)
    })

    it('rejects requests without X-Plexo-Workspace-Id', async () => {
        const headers = authHeaders()
        delete headers['X-Plexo-Workspace-Id']
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(chatBody()),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE_ID')
    })
})

/**
 * URL-routed `/ws/:workspaceId/v1/...` form added in Phase 3c. Reason:
 * Graphiti's OpenAIEmbedderConfig + LLMConfig (graphiti-core 0.29) only
 * forward api_key + base_url to AsyncOpenAI — no default_headers — so the
 * sidecar can't inject X-Plexo-Workspace-Id / X-App-Id per request. The URL
 * carries workspace; the wsRouter synthesizes X-App-Id: graphiti-sidecar.
 */
describe('URL-routed /api/inference/ws/:workspaceId/v1/...', () => {
    function noAppIdHeaders(extra: Record<string, string> = {}): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SERVICE_KEY}`,
            // X-App-Id intentionally OMITTED — wsRouter synthesizes it
            ...extra,
        }
    }

    it('embeddings: extracts workspaceId from URL params, no X-Plexo-Workspace-Id needed', async () => {
        vi.mocked(embed).mockResolvedValueOnce(new Array(256).fill(0.5))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/ws/${VALID_WORKSPACE}/v1/embeddings`, {
            method: 'POST',
            headers: noAppIdHeaders(),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(200)
        expect(embed).toHaveBeenCalledWith('hello', VALID_WORKSPACE)
    })

    it('embeddings: rejects malformed workspaceId in URL (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/ws/not-a-uuid/v1/embeddings`, {
            method: 'POST',
            headers: noAppIdHeaders(),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE_ID')
    })

    it('chat/completions: extracts workspaceId from URL params, synthesizes X-App-Id', async () => {
        const extracted = { facts: [] }
        vi.mocked(callModel).mockResolvedValueOnce({
            object: extracted,
            text: '',
            repairUsed: false,
            inputTokens: 1, outputTokens: 1, latencyMs: 10, model: 'gpt-4o', attempts: 1,
        } as Awaited<ReturnType<typeof callModel>>)

        const base = await getServer()
        const res = await fetch(`${base}/api/inference/ws/${VALID_WORKSPACE}/v1/chat/completions`, {
            method: 'POST',
            headers: noAppIdHeaders(),
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                response_format: { type: 'json_schema', json_schema: { name: 'X', schema: { type: 'object' } } },
            }),
        })
        expect(res.status).toBe(200)
        const opts = vi.mocked(callModel).mock.calls.at(-1)![0]!
        expect(opts.workspaceId).toBe(VALID_WORKSPACE)
    })

    it('chat/completions: still requires Bearer auth even via URL form', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/ws/${VALID_WORKSPACE}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        })
        expect(res.status).toBe(401)
    })
})
