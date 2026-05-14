// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for the Deepgram transcription core.
 *
 * Regression coverage for the Telegram-voice bug: the previous implementation
 * loopback-fetched /api/v1/voice/transcribe, which is mounted behind
 * requireAuth, so server-to-server calls 401'd and Telegram voice notes
 * silently never reached Deepgram. These tests exercise the direct in-process
 * path that replaced it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Stub @plexo/db — transcribeAudio itself never hits the DB (caller passes
// the key in), but the module imports db/workspaces for loadVoiceSettings.
vi.mock('@plexo/db', () => ({
    db: {
        select: vi.fn(),
    },
    eq: vi.fn(),
    workspaces: { id: 'workspaces.id', settings: 'workspaces.settings' },
}))

vi.mock('../../crypto.js', () => ({
    encrypt: vi.fn((s: string) => s),
    decrypt: vi.fn((s: string) => s),
}))

const { transcribeAudio } = await import('../deepgram.js')

// ── fetch mock ──────────────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit | undefined }
const fetchCalls: FetchCall[] = []
let nextFetchResponse: Response | (() => Response) = new Response('{}', { status: 200 })

function mockResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

beforeEach(() => {
    fetchCalls.length = 0
    nextFetchResponse = mockResponse({})
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init })
        return typeof nextFetchResponse === 'function' ? nextFetchResponse() : nextFetchResponse
    }))
})

afterEach(() => {
    vi.unstubAllGlobals()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('transcribeAudio', () => {
    const wsId = '00000000-0000-0000-0000-000000000001'
    const audio = Buffer.from('fake-ogg-opus-bytes')

    it('short-circuits with NO_VOICE_KEY when key is null', async () => {
        const result = await transcribeAudio(null, audio, 'audio/ogg', { workspaceId: wsId, source: 'telegram' })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('NO_VOICE_KEY')
            expect(result.httpStatus).toBe(402)
        }
        // Must not have called Deepgram
        expect(fetchCalls).toHaveLength(0)
    })

    it('rejects an empty audio buffer with NO_AUDIO', async () => {
        const result = await transcribeAudio('key_abc', Buffer.alloc(0), 'audio/ogg', { workspaceId: wsId })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('NO_AUDIO')
        expect(fetchCalls).toHaveLength(0)
    })

    it('rejects oversized audio with TOO_LARGE (>25 MB)', async () => {
        const big = Buffer.alloc(25 * 1024 * 1024 + 1)
        const result = await transcribeAudio('key_abc', big, 'audio/ogg', { workspaceId: wsId })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('TOO_LARGE')
            expect(result.httpStatus).toBe(413)
        }
        expect(fetchCalls).toHaveLength(0)
    })

    it('calls Deepgram /v1/listen with the right URL + headers on happy path', async () => {
        nextFetchResponse = mockResponse({
            metadata: { duration: 2.5 },
            results: {
                channels: [{
                    alternatives: [{
                        transcript: 'hello world',
                        words: [{ w: 'hello' }, { w: 'world' }],
                    }],
                }],
            },
        })

        const result = await transcribeAudio('key_abc', audio, 'audio/ogg', {
            workspaceId: wsId,
            chatId: '12345',
            source: 'telegram',
        })

        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.transcript).toBe('hello world')
            expect(result.words).toBe(2)
            expect(result.duration).toBe(2.5)
        }

        // Verify the wire call
        expect(fetchCalls).toHaveLength(1)
        const call = fetchCalls[0]!
        expect(call.url).toContain('https://api.deepgram.com/v1/listen')
        expect(call.url).toContain('model=nova-3')
        expect(call.url).toContain('smart_format=true')
        expect(call.url).toContain('punctuate=true')
        expect(call.url).toContain('detect_language=true')

        const headers = (call.init?.headers ?? {}) as Record<string, string>
        expect(headers['Authorization']).toBe('Token key_abc')
        expect(headers['Content-Type']).toBe('audio/ogg')
        expect(call.init?.method).toBe('POST')
        // Implementation wraps the Buffer in a Uint8Array (deepgram.ts:363)
        // for fetch-API compatibility. Compare byte equivalence rather than
        // reference identity.
        const sentBytes = Buffer.from(call.init?.body as ArrayBufferLike)
        expect(sentBytes.equals(audio)).toBe(true)
    })

    it('maps Deepgram 401 → INVALID_KEY failure', async () => {
        nextFetchResponse = mockResponse({ err_msg: 'bad token' }, 401)
        const result = await transcribeAudio('bad_key', audio, 'audio/ogg', { workspaceId: wsId })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('INVALID_KEY')
            expect(result.httpStatus).toBe(401)
        }
    })

    it('maps Deepgram 400 UNSUPPORTED_ENCODING → UNSUPPORTED_ENCODING failure', async () => {
        nextFetchResponse = mockResponse({ err_code: 'UNSUPPORTED_ENCODING', err_msg: 'nope' }, 400)
        const result = await transcribeAudio('key_abc', audio, 'audio/weird', { workspaceId: wsId })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('UNSUPPORTED_ENCODING')
            expect(result.httpStatus).toBe(400)
            expect(result.message).toContain('audio/weird')
        }
    })

    it('maps other Deepgram errors → generic DEEPGRAM_ERROR 502', async () => {
        nextFetchResponse = mockResponse({ err_msg: 'upstream is on fire' }, 500)
        const result = await transcribeAudio('key_abc', audio, 'audio/ogg', { workspaceId: wsId })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('DEEPGRAM_ERROR')
            expect(result.httpStatus).toBe(502)
            expect(result.message).toContain('500')
        }
    })

    it('returns empty transcript (ok=true, transcript="") when Deepgram finds silence', async () => {
        nextFetchResponse = mockResponse({
            metadata: { duration: 1 },
            results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] },
        })
        const result = await transcribeAudio('key_abc', audio, 'audio/ogg', { workspaceId: wsId })
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.transcript).toBe('')
            expect(result.words).toBe(0)
        }
    })
})
