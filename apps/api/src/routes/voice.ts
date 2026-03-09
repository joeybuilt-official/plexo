// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Voice / Speech-to-Text routes.
 *
 * GET  /api/voice/settings?workspaceId=...
 *   Returns whether Deepgram is configured (redacted — key never sent to client).
 *
 * PUT  /api/voice/settings
 *   Body: { workspaceId, apiKey }
 *   Encrypts + stores Deepgram API key into workspace.settings.voice.
 *
 * POST /api/voice/transcribe
 *   Query: workspaceId
 *   Body: raw audio bytes (any format Deepgram accepts: webm, ogg, mp3, wav, mp4, …)
 *   Content-Type must be set by the client to the actual audio MIME type.
 *   Returns: { transcript: string, words?: number, duration?: number }
 *
 * POST /api/voice/test
 *   Body: { workspaceId, apiKey? }
 *   Tests the stored (or provided) Deepgram key against their /v1/projects endpoint.
 *   Returns: { ok: boolean, message: string, plan?: string }
 *
 * Key storage: workspace.settings.voice.deepgramApiKey (AES-256-GCM via crypto.ts)
 * Model: nova-3 (Deepgram's current best general-purpose model)
 * Token isolation: completely separate from LLM providers — different budget, different service
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { encrypt, decrypt } from '../crypto.js'
import { logger } from '../logger.js'

export const voiceRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEEPGRAM_API = 'https://api.deepgram.com'
const DEFAULT_MODEL = 'nova-3'
const CONFIGURED_SENTINEL = '__configured__'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEncrypted(v: string): boolean {
    const parts = v.split('.')
    return parts.length === 3 && parts.every((p) => p.length > 0)
}

type VoiceSettings = {
    deepgramApiKey?: string
    enabled?: boolean
}

async function loadVoiceSettings(workspaceId: string): Promise<VoiceSettings> {
    const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)

    const raw = ((ws?.settings as Record<string, unknown>)?.voice ?? {}) as VoiceSettings
    return raw
}

async function getDecryptedKey(workspaceId: string): Promise<string | null> {
    try {
        const settings = await loadVoiceSettings(workspaceId)
        if (!settings.deepgramApiKey) return null
        if (isEncrypted(settings.deepgramApiKey)) {
            return decrypt(settings.deepgramApiKey, workspaceId)
        }
        return settings.deepgramApiKey
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to decrypt Deepgram key')
        return null
    }
}

// ── GET /api/voice/settings ──────────────────────────────────────────────────

voiceRouter.get('/settings', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const settings = await loadVoiceSettings(workspaceId)
        res.json({
            configured: !!settings.deepgramApiKey,
            // Redacted: never return the key value to the client
            apiKey: settings.deepgramApiKey ? CONFIGURED_SENTINEL : null,
            enabled: settings.enabled ?? true,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'GET voice/settings failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load voice settings' } })
    }
})

// ── PUT /api/voice/settings ──────────────────────────────────────────────────

voiceRouter.put('/settings', async (req, res) => {
    const { workspaceId, apiKey, enabled } = req.body as {
        workspaceId?: string
        apiKey?: string
        enabled?: boolean
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const currentSettings = (ws.settings ?? {}) as Record<string, unknown>
        const currentVoice = (currentSettings.voice ?? {}) as VoiceSettings

        const updatedVoice: VoiceSettings = { ...currentVoice }

        if (typeof enabled === 'boolean') updatedVoice.enabled = enabled

        if (apiKey !== undefined) {
            if (apiKey === CONFIGURED_SENTINEL) {
                // Sentinel — keep existing key unchanged
            } else if (apiKey === '__CLEAR__' || apiKey === '') {
                delete updatedVoice.deepgramApiKey
            } else {
                // New key — encrypt before storing
                updatedVoice.deepgramApiKey = encrypt(apiKey, workspaceId)
            }
        }

        const newSettings = { ...currentSettings, voice: updatedVoice }
        await db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, workspaceId))

        logger.info({ workspaceId, hasKey: !!updatedVoice.deepgramApiKey }, 'Voice settings updated')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, workspaceId }, 'PUT voice/settings failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save voice settings' } })
    }
})

// ── POST /api/voice/test ──────────────────────────────────────────────────────

voiceRouter.post('/test', async (req, res) => {
    const { workspaceId, apiKey: incomingKey } = req.body as {
        workspaceId?: string
        apiKey?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ ok: false, message: 'Valid workspaceId required' })
        return
    }

    // Resolve key: incoming plaintext > stored encrypted > nothing
    let key: string | null = null
    if (incomingKey && incomingKey !== CONFIGURED_SENTINEL) {
        key = incomingKey
    } else {
        key = await getDecryptedKey(workspaceId)
    }

    if (!key) {
        res.json({ ok: false, message: 'No Deepgram API key configured.' })
        return
    }

    try {
        const start = Date.now()
        // Hit Deepgram's /v1/projects to validate the key without consuming transcription credits
        const r = await fetch(`${DEEPGRAM_API}/v1/projects`, {
            headers: { Authorization: `Token ${key}` },
            signal: AbortSignal.timeout(8000),
        })
        const latencyMs = Date.now() - start

        if (r.status === 401 || r.status === 403) {
            res.json({ ok: false, message: 'Invalid API key. Check your key at console.deepgram.com.' })
            return
        }
        if (!r.ok) {
            res.json({ ok: false, message: `Deepgram returned ${r.status}` })
            return
        }

        const data = await r.json() as { projects?: { project_id: string; name: string }[] }
        const projectName = data.projects?.[0]?.name ?? 'Unknown'
        res.json({
            ok: true,
            message: `Connected — project "${projectName}" (${latencyMs}ms)`,
            latencyMs,
        })
    } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Connection failed'
        res.json({ ok: false, message })
    }
})

// ── POST /api/voice/transcribe ────────────────────────────────────────────────
// Accepts raw audio bytes. Client must set Content-Type to the audio MIME type.
// Uses express.raw() — mounted per-route so JSON body parsing still works globally.

voiceRouter.post(
    '/transcribe',
    // Parse raw body for this route only — limit 25 MB (Deepgram's max is 2GB but 25 MB is plenty for voice notes)
    (req, res, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contentType = (req.headers['content-type'] ?? '') as string
        if (contentType.startsWith('application/json')) {
            // Already parsed by global express.json() — pass through
            next(); return
        }
        // Raw audio
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
            req.body = Buffer.concat(chunks)
            next()
        })
        req.on('error', next)
    },
    async (req, res) => {
        const { workspaceId } = req.query as { workspaceId?: string }
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
            return
        }

        const key = await getDecryptedKey(workspaceId)
        if (!key) {
            res.status(402).json({
                error: {
                    code: 'NO_VOICE_KEY',
                    message: 'No Deepgram API key configured. Set one up in Settings → Voice.',
                    setupUrl: '/settings/voice',
                },
            })
            return
        }

        const audioBuffer = req.body as Buffer
        if (!audioBuffer || audioBuffer.length === 0) {
            res.status(400).json({ error: { code: 'NO_AUDIO', message: 'Audio body is empty' } })
            return
        }

        // Cap at 25 MB
        if (audioBuffer.length > 25 * 1024 * 1024) {
            res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Audio exceeds 25 MB limit' } })
            return
        }

        const contentType = (req.headers['content-type'] ?? 'audio/webm') as string

        try {
            const deepgramUrl = new URL(`${DEEPGRAM_API}/v1/listen`)
            deepgramUrl.searchParams.set('model', DEFAULT_MODEL)
            deepgramUrl.searchParams.set('smart_format', 'true')
            deepgramUrl.searchParams.set('punctuate', 'true')
            deepgramUrl.searchParams.set('diarize', 'false')
            deepgramUrl.searchParams.set('language', 'en')

            const r = await fetch(deepgramUrl.toString(), {
                method: 'POST',
                headers: {
                    Authorization: `Token ${key}`,
                    'Content-Type': contentType,
                },
                body: audioBuffer,
                signal: AbortSignal.timeout(30_000),
            })

            if (!r.ok) {
                const body = await r.text().catch(() => '')
                logger.warn({ workspaceId, status: r.status, body: body.slice(0, 200) }, 'Deepgram transcription failed')

                if (r.status === 401 || r.status === 403) {
                    res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Deepgram API key is invalid or expired.' } })
                } else {
                    res.status(502).json({ error: { code: 'DEEPGRAM_ERROR', message: `Deepgram returned ${r.status}: ${body.slice(0, 100)}` } })
                }
                return
            }

            const data = await r.json() as {
                results?: {
                    channels?: Array<{
                        alternatives?: Array<{
                            transcript?: string
                            words?: Array<unknown>
                        }>
                    }>
                }
                metadata?: { duration?: number }
            }

            const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
            const wordCount = data.results?.channels?.[0]?.alternatives?.[0]?.words?.length ?? 0
            const duration = data.metadata?.duration ?? 0

            logger.info({ workspaceId, chars: transcript.length, words: wordCount, duration }, 'Voice transcription complete')

            res.json({ transcript, words: wordCount, duration })
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Transcription failed'
            logger.error({ err, workspaceId }, 'Voice transcription error')
            res.status(500).json({ error: { code: 'TRANSCRIPTION_ERROR', message } })
        }
    }
)
