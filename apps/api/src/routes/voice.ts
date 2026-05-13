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
 * GET  /api/voice/usage?workspaceId=...
 *   Fetches the remaining balance for the first Deepgram project linked to the stored key.
 *   Returns: { amount: number, units: string, projectId: string } | { error }
 *
 * Key storage: workspace.settings.voice.deepgramApiKey (AES-256-GCM via crypto.ts)
 * Model: nova-3 (Deepgram's current best general-purpose model)
 * Token isolation: completely separate from LLM providers — different budget, different service
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { encrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import {
    DEEPGRAM_API,
    loadVoiceSettings,
    getDecryptedDeepgramKey,
    transcribeWithFallback,
    type VoiceSettings,
} from '../lib/deepgram.js'

export const voiceRouter: RouterType = Router()

const CONFIGURED_SENTINEL = '__configured__'

// ── GET /api/voice/settings ──────────────────────────────────────────────────

voiceRouter.get('/settings', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

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
    const { workspaceId, apiKey, enabled, ttsModel } = req.body as {
        workspaceId?: string
        apiKey?: string
        enabled?: boolean
        ttsModel?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

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
        if (typeof ttsModel === 'string' && ttsModel) updatedVoice.ttsModel = ttsModel

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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Resolve key: incoming plaintext > stored encrypted > nothing
    let key: string | null = null
    if (incomingKey && incomingKey !== CONFIGURED_SENTINEL) {
        key = incomingKey
    } else {
        key = await getDecryptedDeepgramKey(workspaceId)
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

        if (r.status === 401) {
            res.json({ ok: false, message: 'Invalid API key. Check your key at console.deepgram.com.' })
            return
        }
        if (r.status === 403) {
            // Key is valid but has restricted scopes (project-level keys often can't
            // list all projects — 403 here means auth passed, not that the key is bad).
            // The key will work for transcription, which is all Plexo needs.
            res.json({ ok: true, message: `Connected — key validated (${latencyMs}ms)`, latencyMs })
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
        logger.warn({ err, workspaceId }, 'Voice test connection failed')
        res.json({ ok: false, message: 'Connection to Deepgram failed. Check network connectivity and API key.' })
    }
})

// ── GET /api/voice/usage ──────────────────────────────────────────────────────
// Returns remaining Deepgram balance for the first project on the account.
// Calls Deepgram /v1/projects → /v1/projects/{id}/balances, picks the first balance.

voiceRouter.get('/usage', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const key = await getDecryptedDeepgramKey(workspaceId)
    if (!key) {
        res.status(402).json({ error: { code: 'NO_VOICE_KEY', message: 'No Deepgram API key configured.' } })
        return
    }

    try {
        // 1. Get projects
        const projRes = await fetch(`${DEEPGRAM_API}/v1/projects`, {
            headers: { Authorization: `Token ${key}` },
            signal: AbortSignal.timeout(8000),
        })
        if (!projRes.ok) {
            res.status(502).json({ error: { code: 'DEEPGRAM_ERROR', message: `Deepgram projects returned ${projRes.status}` } })
            return
        }
        const projData = await projRes.json() as { projects?: { project_id: string; name: string }[] }
        const projectId = projData.projects?.[0]?.project_id
        if (!projectId) {
            res.status(404).json({ error: { code: 'NO_PROJECT', message: 'No Deepgram project found for this key.' } })
            return
        }

        // 2. Get balances for that project
        const balRes = await fetch(`${DEEPGRAM_API}/v1/projects/${projectId}/balances`, {
            headers: { Authorization: `Token ${key}` },
            signal: AbortSignal.timeout(8000),
        })
        if (!balRes.ok) {
            res.status(502).json({ error: { code: 'DEEPGRAM_ERROR', message: `Deepgram balances returned ${balRes.status}` } })
            return
        }
        const balData = await balRes.json() as {
            balances?: { balance_id: string; amount: number; units: string; purchase?: number }[]
        }
        const first = balData.balances?.[0]
        if (!first) {
            res.json({ amount: 0, units: 'usd', projectId })
            return
        }

        res.json({ amount: first.amount, units: first.units, projectId })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'GET voice/usage failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch Deepgram usage' } })
    }
})

// ── POST /api/voice/test-transcribe ──────────────────────────────────────────
// End-to-end Deepgram round-trip test. Frontend sends a short (≤10s) audio
// blob captured from the user's mic; backend runs the same transcribe path
// real traffic uses and returns the transcript + latency. This is the
// "Deepgram test button" — distinct from /test which only validates auth.

voiceRouter.post('/test-transcribe', async (req, res) => {
    const { workspaceId, audioBase64, contentType: ct } = req.body as {
        workspaceId?: string
        audioBase64?: string
        contentType?: string
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    if (!audioBase64 || typeof audioBase64 !== 'string') {
        res.status(400).json({ ok: false, error: { code: 'NO_AUDIO', message: 'audioBase64 required' } })
        return
    }
    // Cap inbound size at 5MB base64 (≈ 3.7MB raw). Test clips should be a
    // few seconds, this gives generous headroom without enabling abuse.
    if (audioBase64.length > 5 * 1024 * 1024) {
        res.status(413).json({ ok: false, error: { code: 'TOO_LARGE', message: 'Test audio must be under 5MB' } })
        return
    }
    let buffer: Buffer
    try {
        buffer = Buffer.from(audioBase64, 'base64')
    } catch {
        res.status(400).json({ ok: false, error: { code: 'INVALID_AUDIO', message: 'Could not decode audio' } })
        return
    }
    const contentType = (typeof ct === 'string' && ct.length > 0) ? ct : 'audio/webm'

    const start = Date.now()
    try {
        const result = await transcribeWithFallback(buffer, contentType, {
            workspaceId,
            source: 'voice-test',
        })
        const latencyMs = Date.now() - start
        if (!result.ok) {
            res.json({ ok: false, latencyMs, code: result.code, message: result.message })
            return
        }
        res.json({
            ok: true,
            latencyMs,
            text: result.transcript,
            words: result.words ?? null,
            duration: result.duration ?? null,
        })
    } catch (err) {
        const latencyMs = Date.now() - start
        logger.warn({ err, workspaceId, latencyMs }, 'Voice test-transcribe failed')
        res.json({
            ok: false,
            latencyMs,
            message: err instanceof Error ? err.message : 'Transcription failed',
        })
    }
})

// ── POST /api/voice/transcribe ────────────────────────────────────────────────

// Accepts raw audio bytes. Client must set Content-Type to the audio MIME type.
import express from 'express'
import { UUID_RE } from '../validation.js'

voiceRouter.post(
    '/transcribe',
    express.raw({ type: '*/*', limit: '25mb' }),
    async (req, res) => {
        const { workspaceId } = req.query as { workspaceId?: string }
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

        const audioBuffer = req.body as Buffer
        const contentType = (req.headers['content-type'] ?? 'audio/webm') as string

        const result = await transcribeWithFallback(audioBuffer, contentType, {
            workspaceId,
            source: 'voice-endpoint',
        })

        if (!result.ok) {
            // NO_VOICE_KEY carries a setup URL hint — preserve the richer body
            // shape the dashboard already relies on.
            if (result.code === 'NO_VOICE_KEY') {
                res.status(result.httpStatus).json({
                    error: {
                        code: result.code,
                        message: result.message,
                        setupUrl: '/settings/voice',
                    },
                })
                return
            }
            res.status(result.httpStatus).json({
                error: { code: result.code, message: result.message },
            })
            return
        }

        res.json({
            transcript: result.transcript,
            words: result.words,
            duration: result.duration,
        })
    }
)
