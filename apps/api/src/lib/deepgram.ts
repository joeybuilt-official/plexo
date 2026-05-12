// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Deepgram speech-to-text core.
 *
 * This module owns the actual transcription logic — loading the
 * workspace-scoped API key, calling Deepgram's /v1/listen endpoint,
 * and unwrapping the JSON response.
 *
 * It is consumed by two call sites:
 *   1. apps/api/src/routes/voice.ts — the public HTTP endpoints
 *      (browser-initiated, web-dashboard voice input).
 *   2. apps/api/src/routes/telegram.ts — the Telegram webhook handler,
 *      which calls in-process (no loopback HTTP round-trip). Historically
 *      this path used `fetch('http://localhost:PORT/api/v1/voice/...')`
 *      which failed because /api/v1/voice is mounted behind `requireAuth`
 *      and a server-to-server loopback has no session cookie → 401 →
 *      "configured: false" → user saw the "set up Deepgram" nag even when
 *      Deepgram was fully configured.
 *
 * Key storage: workspace.settings.voice.deepgramApiKey (AES-256-GCM per
 * workspace, via crypto.ts).
 *
 * NO Deepgram SDK dep — we use raw fetch, consistent with the rest of the
 * provider integrations in this codebase.
 */

import { createHash } from 'node:crypto'
import { db, eq, and, asc } from '@plexo/db'
import { workspaces, installedConnections, providerInstances } from '@plexo/db'
import { decrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { getRedis, isRedisAvailable } from '../redis-client.js'

export const DEEPGRAM_API = 'https://api.deepgram.com'
export const DEEPGRAM_DEFAULT_MODEL = 'nova-3'

/** Available Deepgram TTS voices (aura series). */
export const DEEPGRAM_TTS_VOICES = [
    'aura-asteria-en',   // Female, American, warm
    'aura-luna-en',      // Female, American, soft
    'aura-stella-en',    // Female, American, confident
    'aura-athena-en',    // Female, British
    'aura-hera-en',      // Female, American, mature
    'aura-orion-en',     // Male, American
    'aura-arcas-en',     // Male, American, deep
    'aura-perseus-en',   // Male, American, authoritative
    'aura-angus-en',     // Male, Irish
    'aura-orpheus-en',   // Male, American, clear
    'aura-helios-en',    // Male, British
    'aura-zeus-en',      // Male, American, powerful
] as const

export type DeepgramTtsVoice = typeof DEEPGRAM_TTS_VOICES[number]

export type VoiceSettings = {
    deepgramApiKey?: string
    enabled?: boolean
    /** TTS voice model — defaults to aura-asteria-en if not set. */
    ttsModel?: string
}

export type TranscriptionContext = {
    workspaceId: string
    // Optional correlation IDs for richer log lines
    chatId?: string
    taskId?: string
    source?: string // 'telegram' | 'voice-endpoint' | etc.
}

export type TranscriptionSuccess = {
    ok: true
    transcript: string
    words: number
    duration: number
}

export type TranscriptionFailureCode =
    | 'NO_VOICE_KEY'
    | 'NO_AUDIO'
    | 'TOO_LARGE'
    | 'INVALID_KEY'
    | 'UNSUPPORTED_ENCODING'
    | 'DEEPGRAM_ERROR'
    | 'TRANSCRIPTION_ERROR'

export type TranscriptionFailure = {
    ok: false
    code: TranscriptionFailureCode
    message: string
    httpStatus: number
}

export type TranscriptionResult = TranscriptionSuccess | TranscriptionFailure

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect whether a stored value is an encrypted token.
 *
 * Two formats exist in the wild:
 *   - Current: `enc:<iv>.<ciphertext>.<authTag>` (prefixed since crypto.ts
 *     started emitting the `enc:` sentinel).
 *   - Legacy: `<iv>.<ciphertext>.<authTag>` (saved by older versions of the
 *     encrypt path — still present in workspace.settings.voice.deepgramApiKey
 *     rows that were last written before the prefix was introduced).
 *
 * Plaintext Deepgram API keys are ~40 hex-ish chars with no dots, so any value
 * matching the three-part base64url shape is unambiguously an encrypted token.
 *
 * Why: without this fallback, `getDecryptedDeepgramKey` returned the raw
 * ciphertext verbatim and we sent it to Deepgram as the API key → 401 across
 * all channels. This was the root cause of the "Deepgram API key is invalid
 * or expired" error the user hit on every voice message.
 */
function isEncrypted(v: string): boolean {
    if (v.startsWith('enc:')) return true
    const parts = v.split('.')
    if (parts.length !== 3) return false
    return parts.every((p) => p.length > 8 && /^[A-Za-z0-9_-]+$/.test(p))
}

export async function loadVoiceSettings(workspaceId: string): Promise<VoiceSettings> {
    const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)

    const raw = ((ws?.settings as Record<string, unknown>)?.voice ?? {}) as VoiceSettings

    // If voice settings has no key, check installed_connections for a Deepgram
    // integration so callers (including the Settings → Voice page) report
    // configured: true when Deepgram was set up via the Integrations page.
    if (!raw.deepgramApiKey) {
        const connKey = await getDeepgramKeyFromConnections(workspaceId)
        if (connKey) {
            // Surface a sentinel so callers see "configured" without leaking the key
            raw.deepgramApiKey = '__connection__'
        }
    }

    return raw
}

/**
 * Pull the Deepgram API key from the installed_connections table.
 * Credentials are stored as { encrypted: "<AES-256-GCM string>" }
 * and decrypt to a JSON object with an `api_key` field.
 */
async function getDeepgramKeyFromConnections(workspaceId: string): Promise<string | null> {
    try {
        const [row] = await db
            .select({ credentials: installedConnections.credentials })
            .from(installedConnections)
            .where(
                and(
                    eq(installedConnections.workspaceId, workspaceId),
                    eq(installedConnections.registryId, 'deepgram'),
                    eq(installedConnections.status, 'active'),
                ),
            )
            .limit(1)

        if (!row) return null

        const raw = row.credentials as Record<string, unknown>
        if (!raw.encrypted) return null

        const decrypted = decrypt(raw.encrypted as string, workspaceId)
        const creds = JSON.parse(decrypted) as Record<string, string>
        return creds.api_key ?? creds.apiKey ?? creds.token ?? Object.values(creds).find(v => v) ?? null
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to read Deepgram key from installed connections')
        return null
    }
}

export async function getDecryptedDeepgramKey(workspaceId: string): Promise<string | null> {
    const candidates = await getDeepgramKeyCandidates(workspaceId)
    return candidates[0] ?? null
}

/**
 * Return every Deepgram key we can find for this workspace, in priority order.
 *
 * Why an array: users can configure Deepgram via TWO different surfaces
 * (Settings → Voice, and Integrations page) and those writes land in
 * different tables. In practice one of them is often stale (rotated key
 * only updated in one place). The transcription orchestrator iterates
 * this list and falls through to the next candidate on INVALID_KEY so a
 * single rotation oversight doesn't break voice.
 *
 * Dedup is explicit: a user with the same key saved in both places will
 * see it once, not twice.
 */
export async function getDeepgramKeyCandidates(workspaceId: string): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const add = (key: string | null | undefined): void => {
        if (!key) return
        if (seen.has(key)) return
        seen.add(key)
        out.push(key)
    }

    try {
        // 1. Workspace voice settings (Settings → Voice page)
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const voiceRaw = ((ws?.settings as Record<string, unknown>)?.voice ?? {}) as VoiceSettings
        if (voiceRaw.deepgramApiKey) {
            try {
                add(isEncrypted(voiceRaw.deepgramApiKey)
                    ? decrypt(voiceRaw.deepgramApiKey, workspaceId)
                    : voiceRaw.deepgramApiKey)
            } catch (err) {
                logger.warn({ err, workspaceId }, 'voice settings: Deepgram key decrypt failed — will still try other sources')
            }
        }

        // 2. installed_connections (Integrations page)
        add(await getDeepgramKeyFromConnections(workspaceId))
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to enumerate Deepgram key candidates')
    }

    return out
}

// ── Text-to-speech ──────────────────────────────────────────────────────────

const TTS_DEFAULT_MODEL = 'aura-asteria-en'
const TTS_MAX_CHARS = 4000

/**
 * Synthesize speech from text via Deepgram TTS /v1/speak.
 *
 * Reads the workspace's preferred TTS voice from settings.voice.ttsModel,
 * falling back to aura-asteria-en if not configured.
 *
 * Returns an OGG/OPUS buffer suitable for Telegram's sendVoice API,
 * or null on any failure (caller should gracefully degrade to text-only).
 */
export async function synthesizeSpeech(workspaceId: string, text: string): Promise<Buffer | null> {
    if (!text || text.length > TTS_MAX_CHARS) return null

    const settings = await loadVoiceSettings(workspaceId)
    // Use getDecryptedDeepgramKey which already handles both voice settings
    // and installed_connections fallback.
    const key = await getDecryptedDeepgramKey(workspaceId)
    if (!key) return null

    const ttsModel = settings.ttsModel && DEEPGRAM_TTS_VOICES.includes(settings.ttsModel as DeepgramTtsVoice)
        ? settings.ttsModel
        : TTS_DEFAULT_MODEL

    try {
        const res = await fetch(
            `${DEEPGRAM_API}/v1/speak?model=${ttsModel}&encoding=opus&container=ogg`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Token ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(30_000),
            },
        )

        if (!res.ok) {
            logger.warn(
                { workspaceId, status: res.status, model: ttsModel },
                'Deepgram TTS request failed',
            )
            return null
        }

        const buf = Buffer.from(await res.arrayBuffer())
        logger.info(
            { workspaceId, textLength: text.length, audioBytes: buf.length, model: ttsModel },
            'Deepgram TTS synthesis complete',
        )
        return buf
    } catch (err) {
        logger.warn({ err, workspaceId, model: ttsModel }, 'Deepgram TTS error (exception)')
        return null
    }
}

// ── Core transcription ──────────────────────────────────────────────────────

const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // 25 MB

type DeepgramResponse = {
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

/**
 * Transcribe raw audio bytes via Deepgram /v1/listen.
 *
 * - Caller supplies the decrypted API key (pass `null` to short-circuit with
 *   NO_VOICE_KEY). We accept the key explicitly — rather than re-fetching —
 *   so callers that have already loaded workspace settings (e.g. the voice
 *   HTTP route, which needs the "configured" flag anyway) don't double-hit
 *   the DB.
 * - `contentType` MUST be the actual audio MIME type. For Telegram voice
 *   notes (OPUS in an OGG container) use 'audio/ogg'.
 * - On failure we log loudly with the provided context (workspaceId, taskId,
 *   chatId) so production issues are visible in `docker logs | grep deepgram`.
 */
export async function transcribeAudio(
    key: string | null,
    audioBuffer: Buffer,
    contentType: string,
    ctx: TranscriptionContext,
): Promise<TranscriptionResult> {
    if (!key) {
        return {
            ok: false,
            code: 'NO_VOICE_KEY',
            message: 'No Deepgram API key configured. Set one up in Settings → Voice.',
            httpStatus: 402,
        }
    }
    if (!audioBuffer || audioBuffer.length === 0) {
        return { ok: false, code: 'NO_AUDIO', message: 'Audio body is empty', httpStatus: 400 }
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        return { ok: false, code: 'TOO_LARGE', message: 'Audio exceeds 25 MB limit', httpStatus: 413 }
    }

    const deepgramUrl = new URL(`${DEEPGRAM_API}/v1/listen`)
    deepgramUrl.searchParams.set('model', DEEPGRAM_DEFAULT_MODEL)
    deepgramUrl.searchParams.set('smart_format', 'true')
    deepgramUrl.searchParams.set('punctuate', 'true')
    deepgramUrl.searchParams.set('diarize', 'false')
    // detect_language=true is more robust for global usage
    deepgramUrl.searchParams.set('detect_language', 'true')

    try {
        const r = await fetch(deepgramUrl.toString(), {
            method: 'POST',
            headers: {
                Authorization: `Token ${key}`,
                'Content-Type': contentType,
            },
            body: new Uint8Array(audioBuffer),
            signal: AbortSignal.timeout(30_000),
        })

        if (!r.ok) {
            const body = (await r.json().catch(() => ({ message: 'No error message in response body' }))) as Record<string, unknown>
            logger.error(
                { ...ctx, status: r.status, error: body, contentType, bytes: audioBuffer.length },
                'Deepgram transcription failed',
            )
            trackEvent('voice.transcription_failed', 'error', {
                workspaceId: ctx.workspaceId,
                status: r.status,
                source: ctx.source ?? 'unknown',
            })

            if (r.status === 401 || r.status === 403) {
                return {
                    ok: false,
                    code: 'INVALID_KEY',
                    message: 'Deepgram API key is invalid or expired.',
                    httpStatus: 401,
                }
            }
            if (r.status === 400 && body.err_code === 'UNSUPPORTED_ENCODING') {
                return {
                    ok: false,
                    code: 'UNSUPPORTED_ENCODING',
                    message: `Deepgram does not support the provided audio encoding (${contentType}). Try sending a different format.`,
                    httpStatus: 400,
                }
            }
            return {
                ok: false,
                code: 'DEEPGRAM_ERROR',
                message: `Deepgram returned ${r.status}: ${body.err_msg || body.message || 'Unknown error'}`,
                httpStatus: 502,
            }
        }

        const data = (await r.json()) as DeepgramResponse
        const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
        const wordCount = data.results?.channels?.[0]?.alternatives?.[0]?.words?.length ?? 0
        const duration = data.metadata?.duration ?? 0

        logger.info(
            { ...ctx, chars: transcript.length, words: wordCount, duration, contentType },
            'Voice transcription complete',
        )
        trackEvent('voice.transcription_completed', 'info', {
            workspaceId: ctx.workspaceId,
            words: wordCount,
            durationSec: duration,
            source: ctx.source ?? 'unknown',
        })

        return { ok: true, transcript, words: wordCount, duration }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'unknown'
        logger.error({ err, ...ctx, contentType }, 'Voice transcription error (exception)')
        trackEvent('voice.transcription_failed', 'error', {
            workspaceId: ctx.workspaceId,
            error: errMsg,
            source: ctx.source ?? 'unknown',
        })
        return {
            ok: false,
            code: 'TRANSCRIPTION_ERROR',
            message: 'Transcription failed. Please try again.',
            httpStatus: 500,
        }
    }
}

// ── Resilience: bad-key cache + circuit breaker ─────────────────────────────
//
// Two independent guards layered on top of transcribeAudio:
//
//   1. Bad-key cache (Redis, 5-min TTL, keyed by SHA-256 of the API key).
//      When Deepgram returns 401/403 for a candidate, we remember it so the
//      next voice message doesn't retry the same dead key. 5 minutes is long
//      enough to smooth bursty usage, short enough that a real key rotation
//      recovers without manual intervention.
//
//   2. Circuit breaker (in-memory, per-process).
//      If Deepgram returns 5xx or the fetch throws repeatedly, we open the
//      breaker and skip Deepgram entirely for COOLDOWN_MS. All traffic goes
//      straight to the Groq Whisper fallback during the cooldown window.
//
// Neither guard is a correctness requirement — they exist purely to prevent
// wasted calls and user-visible latency spikes when Deepgram is misbehaving.

const BAD_KEY_TTL_SEC = 5 * 60
const BREAKER_FAILURE_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 60_000

const breakerState = { failures: 0, openedAt: 0 }

function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

async function isKeyKnownBad(key: string): Promise<boolean> {
    if (!isRedisAvailable()) return false
    try {
        const r = await getRedis()
        return (await r.get(`deepgram:badkey:${hashKey(key)}`)) === '1'
    } catch (err) {
        logger.debug({ err }, 'bad-key cache lookup failed — proceeding without cache')
        return false
    }
}

async function markKeyBad(key: string): Promise<void> {
    if (!isRedisAvailable()) return
    try {
        const r = await getRedis()
        await r.set(`deepgram:badkey:${hashKey(key)}`, '1', { EX: BAD_KEY_TTL_SEC })
    } catch (err) {
        logger.debug({ err }, 'bad-key cache write failed — non-fatal')
    }
}

function breakerOpen(): boolean {
    if (breakerState.failures < BREAKER_FAILURE_THRESHOLD) return false
    if (Date.now() - breakerState.openedAt > BREAKER_COOLDOWN_MS) {
        breakerState.failures = 0
        breakerState.openedAt = 0
        return false
    }
    return true
}

function recordBreakerFailure(): void {
    breakerState.failures += 1
    if (breakerState.failures === BREAKER_FAILURE_THRESHOLD) {
        breakerState.openedAt = Date.now()
        logger.warn({ cooldownMs: BREAKER_COOLDOWN_MS }, 'Deepgram circuit breaker OPEN — routing to Groq fallback')
    }
}

function recordBreakerSuccess(): void {
    if (breakerState.failures > 0 || breakerState.openedAt > 0) {
        logger.info('Deepgram circuit breaker reset after successful call')
    }
    breakerState.failures = 0
    breakerState.openedAt = 0
}

// ── Groq Whisper fallback ────────────────────────────────────────────────────
//
// When every Deepgram candidate fails (bad keys, breaker open, transient 5xx),
// we fall back to Groq's whisper-large-v3-turbo endpoint. The user already
// has a Groq provider instance configured for chat inference, so we reuse
// that key rather than introducing a third provider surface.

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3-turbo'

/**
 * Load the workspace's Groq API key from provider_instances.
 *
 * Falls back to process.env.GROQ_API_KEY for the ops/system workspace path
 * that doesn't have per-workspace Groq credentials.
 */
async function getGroqApiKey(workspaceId: string): Promise<string | null> {
    try {
        const [row] = await db
            .select({ encryptedKey: providerInstances.encryptedKey })
            .from(providerInstances)
            .where(
                and(
                    eq(providerInstances.workspaceId, workspaceId),
                    eq(providerInstances.providerType, 'groq'),
                    eq(providerInstances.enabled, true),
                ),
            )
            .orderBy(asc(providerInstances.preferenceOrder))
            .limit(1)

        if (row?.encryptedKey) {
            try {
                return decrypt(row.encryptedKey, workspaceId)
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Failed to decrypt Groq key from provider_instances')
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to read Groq provider instance')
    }
    return process.env.GROQ_API_KEY ?? null
}

function extFromContentType(contentType: string): string {
    const base = contentType.split(';')[0]!.trim().toLowerCase()
    if (base.includes('ogg')) return 'ogg'
    if (base.includes('mp4')) return 'mp4'
    if (base.includes('m4a') || base.includes('aac')) return 'm4a'
    if (base.includes('mpeg') || base.includes('mp3')) return 'mp3'
    if (base.includes('wav')) return 'wav'
    if (base.includes('webm')) return 'webm'
    if (base.includes('flac')) return 'flac'
    return 'ogg'
}

async function transcribeWithGroq(
    key: string,
    audioBuffer: Buffer,
    contentType: string,
    ctx: TranscriptionContext,
): Promise<TranscriptionResult> {
    try {
        const form = new FormData()
        const ext = extFromContentType(contentType)
        form.append('file', new Blob([new Uint8Array(audioBuffer)], { type: contentType }), `audio.${ext}`)
        form.append('model', GROQ_MODEL)
        form.append('response_format', 'verbose_json')

        const r = await fetch(GROQ_TRANSCRIPTION_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.timeout(30_000),
        })

        if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
            logger.warn({ ...ctx, status: r.status, error: body }, 'Groq transcription failed')
            trackEvent('voice.transcription_failed', 'error', {
                workspaceId: ctx.workspaceId,
                status: r.status,
                provider: 'groq',
                source: ctx.source ?? 'unknown',
            })
            if (r.status === 401 || r.status === 403) {
                return { ok: false, code: 'INVALID_KEY', message: 'Groq API key is invalid or expired.', httpStatus: 401 }
            }
            return {
                ok: false,
                code: 'DEEPGRAM_ERROR',
                message: `Groq fallback returned ${r.status}`,
                httpStatus: 502,
            }
        }

        const data = (await r.json()) as { text?: string; duration?: number; segments?: Array<{ text?: string }> }
        const transcript = (data.text ?? '').trim()
        const duration = data.duration ?? 0
        logger.info(
            { ...ctx, chars: transcript.length, duration, provider: 'groq' },
            'Voice transcription complete (Groq fallback)',
        )
        trackEvent('voice.transcription_completed', 'info', {
            workspaceId: ctx.workspaceId,
            durationSec: duration,
            provider: 'groq',
            source: ctx.source ?? 'unknown',
        })
        return { ok: true, transcript, words: transcript.split(/\s+/).filter(Boolean).length, duration }
    } catch (err) {
        logger.error({ err, ...ctx }, 'Groq transcription error (exception)')
        return {
            ok: false,
            code: 'TRANSCRIPTION_ERROR',
            message: 'Fallback transcription failed.',
            httpStatus: 500,
        }
    }
}

/**
 * Returns true if ANY transcription provider is configured for this workspace
 * (Deepgram voice settings, Deepgram installed connection, Groq provider
 * instance, or env-level GROQ_API_KEY). Used by channel handlers to decide
 * whether to nag the user to configure voice before attempting transcription.
 */
export async function hasAnyTranscriptionProvider(workspaceId: string): Promise<boolean> {
    const deepgramCandidates = await getDeepgramKeyCandidates(workspaceId)
    if (deepgramCandidates.length > 0) return true
    const groqKey = await getGroqApiKey(workspaceId)
    return !!groqKey
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Transcribe with full resilience: iterate Deepgram key candidates, skip
 * known-bad keys, retry transient failures once, fall back to Groq Whisper.
 *
 * Call sites (telegram.ts, voice.ts POST /transcribe) should prefer this over
 * the primitive transcribeAudio — it handles the real-world failure modes
 * (stale key in one storage location, transient 5xx, Deepgram region outage)
 * without user-facing errors.
 */
export async function transcribeWithFallback(
    audioBuffer: Buffer,
    contentType: string,
    ctx: TranscriptionContext,
): Promise<TranscriptionResult> {
    if (!audioBuffer || audioBuffer.length === 0) {
        return { ok: false, code: 'NO_AUDIO', message: 'Audio body is empty', httpStatus: 400 }
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        return { ok: false, code: 'TOO_LARGE', message: 'Audio exceeds 25 MB limit', httpStatus: 413 }
    }

    const candidates = await getDeepgramKeyCandidates(ctx.workspaceId)
    let lastFailure: TranscriptionFailure | null = null
    const skipDeepgram = breakerOpen()

    if (!skipDeepgram) {
        for (const key of candidates) {
            if (await isKeyKnownBad(key)) {
                logger.debug({ ...ctx }, 'Skipping Deepgram candidate marked bad in cache')
                continue
            }

            let result = await transcribeAudio(key, audioBuffer, contentType, ctx)

            // One retry on transient DEEPGRAM_ERROR / TRANSCRIPTION_ERROR
            if (!result.ok && (result.code === 'DEEPGRAM_ERROR' || result.code === 'TRANSCRIPTION_ERROR')) {
                await new Promise((r) => setTimeout(r, 500))
                result = await transcribeAudio(key, audioBuffer, contentType, ctx)
            }

            if (result.ok) {
                recordBreakerSuccess()
                return result
            }

            lastFailure = result
            if (result.code === 'INVALID_KEY') {
                await markKeyBad(key)
                continue
            }
            if (result.code === 'DEEPGRAM_ERROR' || result.code === 'TRANSCRIPTION_ERROR') {
                recordBreakerFailure()
                break
            }
            return result
        }
    }

    // Fall through to Groq Whisper
    const groqKey = await getGroqApiKey(ctx.workspaceId)
    if (!groqKey) {
        if (lastFailure) return lastFailure
        if (candidates.length === 0) {
            return {
                ok: false,
                code: 'NO_VOICE_KEY',
                message: 'No transcription provider configured. Set up Deepgram in Settings → Voice or Groq in Integrations.',
                httpStatus: 402,
            }
        }
        return {
            ok: false,
            code: 'INVALID_KEY',
            message: 'All Deepgram API keys are invalid. Update your key in Settings → Voice or configure Groq as a fallback.',
            httpStatus: 401,
        }
    }

    logger.info({ ...ctx, reason: skipDeepgram ? 'breaker_open' : 'deepgram_failed' }, 'Falling back to Groq Whisper')
    return transcribeWithGroq(groqKey, audioBuffer, contentType, ctx)
}
