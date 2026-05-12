// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Telegram channel adapter.
 *
 * Architecture:
 * - Each channel row in DB gets its own webhook URL:
 *   /api/v1/channels/telegram/webhook/:channelId
 * - The channelId determines the bot token AND the workspace — no shared
 *   global state, no chat-to-workspace guessing. N bots work independently.
 * - Local dev: long-polling per bot (first registered bot only; multi-bot
 *   polling is a Telegram API limitation — each bot needs a separate process).
 *
 * Message routing:
 * - Conversational messages → direct AI reply (no task queued)
 * - Task requests → queued, agent executes, replies when done
 *
 * Every message exchange is recorded in the `conversations` table with:
 *   - source: 'telegram'
 *   - sessionId: 'telegram:{channelId}:{chatId}'  (stable per chat)
 *   - channelRef: { channel: 'telegram', channelId, chatId }
 *
 * This enables:
 *   - Full conversation history in Plexo web UI
 *   - "Continue in web" → restores full thread context
 *   - Bidirectional: web replies route back to the originating Telegram chat
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { timingSafeStringEqual } from '../lib/timing-safe-equal.js'
import { pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { emitToWorkspace, onAgentEvent } from '../sse-emitter.js'
import { db, eq, sql } from '@plexo/db'
import { channels, sprints } from '@plexo/db'
import { detectCredentialMessage, autoInstallConnection } from '../credential-setup.js'
import { ulid } from 'ulid'
import { chatWithAI, classifyIntent, ChannelChatHistory, buildConversationSystemPrompt, translateErrorForUser, TASK_SUGGEST_HINT } from '../channel-ai.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import {
    recordConversation,
    linkTaskToConversation,
    SESSION_TIMEOUT_MS,
    type ChannelRef,
} from '../conversation-log.js'
import { resolveSessionId, persistTurnEmbedding } from '../lib/session-resolver.js'
import { loadVoiceSettings, transcribeWithFallback, synthesizeSpeech, hasAnyTranscriptionProvider } from '../lib/deepgram.js'
import { markTaskDelivered } from '../channel-delivery.js'
import { trackDelivery } from '../delivery-tracker.js'
import { maybeReact } from '@plexo/agent/channels/reaction-manager'
import { sanitizeForTelegram } from '../lib/telegram-sanitize.js'

export const telegramRouter: RouterType = Router()

// ── Per-channel registry ──────────────────────────────────────────────────────

interface ChannelEntry {
    token: string
    workspaceId: string
}

/** channelId → { token, workspaceId } */
const _channels = new Map<string, ChannelEntry>()

let _webhookSecret: string | null = null

// ── Webhook deduplication ────────────────────────────────────────────────────
// Telegram retries webhook deliveries on network hiccups. Without dedup,
// each retry triggers a full handleUpdate → duplicate bot responses.
// TTL-based: entries expire after 60s (well beyond Telegram's retry window).

const _processedUpdates = new Map<number, number>() // update_id → timestamp
const DEDUP_TTL_MS = 60_000

function isDuplicateUpdate(updateId: number): boolean {
    const now = Date.now()
    // Prune expired entries (batched — only when map grows)
    if (_processedUpdates.size > 200) {
        for (const [id, ts] of _processedUpdates) {
            if (now - ts > DEDUP_TTL_MS) _processedUpdates.delete(id)
        }
    }
    if (_processedUpdates.has(updateId)) return true
    _processedUpdates.set(updateId, now)
    return false
}

// ── Telegram API helpers ──────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot'

// Rate-limit vision nudge to once per 24h per workspace (in-memory, resets on restart)
const _visionNudgeSent = new Set<string>()

interface SendTrackingCtx {
    workspaceId: string
    conversationId?: string
}

async function sendMessage(token: string, chatId: number | string, text: string, tracking?: SendTrackingCtx): Promise<void> {
    const startMs = Date.now()

    if (!text || !text.trim()) {
        logger.warn({ chatId }, 'Telegram sendMessage called with empty text — skipping')
        if (tracking) {
            trackDelivery({
                workspaceId: tracking.workspaceId,
                channel: 'telegram',
                chatId: String(chatId),
                status: 'empty_response',
                errorMessage: 'sendMessage called with empty text',
                messageLength: 0,
                latencyMs: 0,
                conversationId: tracking.conversationId,
            })
        }
        return
    }
    // Phase 5: sanitize to plain text before sending. Telegram's Markdown/HTML
    // parsers reject stray `**`, unbalanced backticks, and bare `<>`. Plain
    // text never fails to parse and matches the user's stated preference
    // ("no markdown, no emoji in every response").
    const sanitized = sanitizeForTelegram(text, 'plain')
    if (!sanitized.trim()) {
        logger.warn({ chatId }, 'Telegram sendMessage text became empty after sanitize — skipping')
        return
    }
    try {
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: sanitized }),
            signal: AbortSignal.timeout(8_000),
        })
        const latencyMs = Date.now() - startMs
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.error({ status: res.status, body, chatId }, 'Telegram sendMessage HTTP error')
            if (tracking) {
                trackDelivery({
                    workspaceId: tracking.workspaceId,
                    channel: 'telegram',
                    chatId: String(chatId),
                    status: res.status === 400 ? 'rejected' : 'failed',
                    errorMessage: `HTTP ${res.status}: ${body.slice(0, 500)}`,
                    messageLength: sanitized.length,
                    latencyMs,
                    conversationId: tracking.conversationId,
                })
            }
        } else {
            if (tracking) {
                trackDelivery({
                    workspaceId: tracking.workspaceId,
                    channel: 'telegram',
                    chatId: String(chatId),
                    status: 'sent',
                    messageLength: sanitized.length,
                    latencyMs,
                    conversationId: tracking.conversationId,
                })
            }
        }
    } catch (err) {
        logger.error({ err, chatId }, 'Telegram sendMessage network error')
        if (tracking) {
            trackDelivery({
                workspaceId: tracking.workspaceId,
                channel: 'telegram',
                chatId: String(chatId),
                status: 'failed',
                errorMessage: `Network error: ${(err as Error).message}`,
                messageLength: sanitized.length,
                latencyMs: Date.now() - startMs,
                conversationId: tracking.conversationId,
            })
        }
    }
}

/** Send a message and return the message_id for later editing. */
async function sendMessageGetId(token: string, chatId: number | string, text: string): Promise<number | null> {
    try {
        const sanitized = sanitizeForTelegram(text, 'plain')
        if (!sanitized.trim()) return null
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: sanitized }),
            signal: AbortSignal.timeout(8_000),
        })
        if (!res.ok) return null
        const data = await res.json() as { result?: { message_id?: number } }
        return data.result?.message_id ?? null
    } catch { return null }
}

/** Edit an existing message in place. */
async function editMessage(token: string, chatId: number | string, messageId: number, text: string): Promise<boolean> {
    try {
        const sanitized = sanitizeForTelegram(text, 'plain')
        if (!sanitized.trim()) return false
        const res = await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: sanitized }),
            signal: AbortSignal.timeout(8_000),
        })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            if (res.status === 400 && body.includes('parse')) {
                // Should not happen now that we send plain text, but keep a
                // no-op retry for safety so logs surface the anomaly clearly.
                logger.warn({ chatId, messageId, body }, 'Telegram editMessage 400 despite plain-text sanitize')
                return false
            }
            return false
        }
        return true
    } catch { return false }
}

async function sendTyping(token: string, chatId: number | string): Promise<void> {
    await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: AbortSignal.timeout(5_000),
    }).catch(() => null)
}

/** Send a voice note (OGG/OPUS buffer) via Telegram's sendVoice API. */
async function sendVoice(token: string, chatId: number | string, audio: Buffer, caption?: string): Promise<boolean> {
    try {
        const form = new FormData()
        form.append('chat_id', String(chatId))
        form.append('voice', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'response.ogg')
        if (caption) form.append('caption', caption.slice(0, 1024))
        const res = await fetch(`${TELEGRAM_API}${token}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.warn({ chatId, status: res.status, body: body.slice(0, 300) }, 'Telegram sendVoice failed')
            return false
        }
        return true
    } catch (err) {
        logger.warn({ err, chatId }, 'Telegram sendVoice error')
        return false
    }
}

/** Delete a message silently. Returns true on success. */
async function deleteMessageSilent(token: string, chatId: number | string, messageId: number): Promise<boolean> {
    try {
        const res = await fetch(`${TELEGRAM_API}${token}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
            signal: AbortSignal.timeout(5_000),
        })
        return res.ok
    } catch { return false }
}

async function setWebhook(token: string, url: string, secret: string): Promise<void> {
    const res = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret }),
        signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json() as { ok: boolean; description?: string }
    if (data.ok) logger.info({ url }, 'Telegram webhook registered')
    else logger.error({ description: data.description }, 'Telegram webhook registration failed')
    if (!data?.ok) trackEvent('channel.error', 'error', { channel: 'telegram', error: 'webhook_registration_failed' })
}

async function deleteWebhook(token: string): Promise<void> {
    await fetch(`${TELEGRAM_API}${token}/deleteWebhook`, { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(() => null)
}

// ── Chat history (shared helper from channel-ai.ts) ────────────────────────

const chatHistory = new ChannelChatHistory()

function historyKey(channelId: string, chatId: string): string {
    return `${channelId}:${chatId}`
}

/**
 * Session ID for a Telegram chat — used as conversations.session_id.
 *
 * Sessions auto-split after SESSION_TIMEOUT_MS of inactivity so that each
 * distinct conversation appears as a separate entry in the conversations list.
 *
 * Backed by the `conversations` table (not in-memory state) so sessions are
 * stable across API restarts. If the prior message for this chat is within
 * the gap window, the existing session_id is reused; otherwise a new ULID is
 * appended and a fresh session begins.
 */
const SESSION_GAP_MS = SESSION_TIMEOUT_MS

/** Track last-activity per chat so we can clear in-memory chat history when a new session starts. */
const lastActivityByChat = new Map<string, number>()

/**
 * Clear the per-chat in-memory history when the universal session resolver
 * decides a new session has started (time gap, topic change, explicit break,
 * or task completion). Keeps the local AI context in sync with the persisted
 * session boundary.
 */
function maybeResetHistory(channelId: string, chatId: string, isNewSession: boolean): void {
    const key = `${channelId}:${chatId}`
    if (isNewSession) chatHistory.delete(key)
    lastActivityByChat.set(key, Date.now())
}

function addToHistory(channelId: string, chatId: string, role: 'user' | 'assistant', content: string, imageUrls?: string[]): void {
    chatHistory.add(historyKey(channelId, chatId), role, content, imageUrls)
}

// ── Last completed task tracker (per chat) ─────────────────────────────────

interface CompletedTaskInfo {
    taskId: string
    summary: string
    completedAt: number
}

/** chatKey → last completed task info. Used for follow-up detection + context. */
const lastCompletedTask = new Map<string, CompletedTaskInfo>()

/** How long after completion a follow-up is still recognized (5 minutes). */
const FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000

function getRecentCompletion(channelId: string, chatId: string): CompletedTaskInfo | null {
    const key = `${channelId}:${chatId}`
    const info = lastCompletedTask.get(key)
    if (!info) return null
    if (Date.now() - info.completedAt > FOLLOW_UP_WINDOW_MS) {
        lastCompletedTask.delete(key)
        return null
    }
    return info
}

// ── Follow-up pattern detection ────────────────────────────────────────────

const FOLLOW_UP_PATTERNS = [
    /^send\s*(it|them|the\s+results?)\s*(here)?$/i,
    /^show\s*(me|it|them)$/i,
    /^paste\s*(it|them)?$/i,
    /^give\s*(me|it)$/i,
    /^(yes|do\s+it|go|proceed|ok|sure|yep|yeah)$/i,
    /^send\s+the\s+results?$/i,
    /^(show|send|give|paste)\s*(me\s+)?(the\s+)?(details|output|content|deliverable|result)s?$/i,
    // Contextual follow-ups: user asks for something the bot just offered (link, file, report, etc.)
    /^(give|send|show|share)\s+me\s+(a\s+|the\s+)?(link|url|file|report|summary|document)/i,
    /^(can\s+(i|you)\s+)?(get|have|see)\s+(a\s+|the\s+)?(link|url|file|report|summary|document)/i,
    /^(yes,?\s*)?(please|go ahead|send\s+it|do\s+it|share\s+it)[.!,\s]*$/i,
    /^(i('d)?\s+)?(want|like|need)\s+(the\s+|a\s+)?(link|results?|output|file|report)/i,
    /^link\s*(please|pls)?[.!?]*$/i,
]

function isFollowUpMessage(text: string, recentCompletion: CompletedTaskInfo | null): boolean {
    if (!recentCompletion) return false
    const trimmed = text.trim()
    if (trimmed.length > 80) return false
    return FOLLOW_UP_PATTERNS.some(p => p.test(trimmed))
}

/**
 * Returns true only when the user's message shares significant keywords with
 * the completed task summary. Prevents ghost responses where an unrelated
 * task's completion (e.g. an SEO audit) gets injected as context for a
 * question about something else entirely (e.g. Deepgram).
 */
function isMessageRelatedToCompletion(summary: string, userMessage: string): boolean {
    const STOP = new Set(['about', 'after', 'also', 'been', 'before', 'could', 'every', 'from', 'have', 'here', 'into', 'just', 'more', 'most', 'other', 'over', 'should', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your'])
    const words = (s: string) => new Set(
        s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 4 && !STOP.has(w))
    )
    const summaryWords = words(summary)
    for (const w of words(userMessage)) {
        if (summaryWords.has(w)) return true
    }
    return false
}

// ── Asset content reader ────────────────────────────────────────────────────

async function readTaskAssets(taskId: string): Promise<string | null> {
    try {
        const { promises: fsp } = await import('node:fs')
        const { join } = await import('node:path')
        const dir = `/tmp/plexo-assets/${taskId}`
        try { await fsp.access(dir) } catch { return null }
        const allFiles = await fsp.readdir(dir)
        const files = allFiles.filter(f => !(/\.(png|jpg|jpeg|gif|webp)$/i.test(f)))
        if (files.length === 0) return null
        const contents = await Promise.all(files.map(f => fsp.readFile(join(dir, f), 'utf8')))
        const parts = contents.map((content, i) => files.length > 1 ? `--- ${files[i]} ---\n${content}` : content)
        return parts.join('\n\n')
    } catch {
        return null
    }
}

// ── Telegram message splitting (4096 char limit) ────────────────────────────

const TG_MAX_LEN = 4096

function splitForTelegram(text: string): string[] {
    if (text.length <= TG_MAX_LEN) return [text]
    const messages: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= TG_MAX_LEN) {
            messages.push(remaining)
            break
        }
        // Try to split at a newline near the limit
        let splitAt = remaining.lastIndexOf('\n', TG_MAX_LEN)
        if (splitAt < TG_MAX_LEN * 0.5) splitAt = TG_MAX_LEN
        messages.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt).trimStart()
    }
    return messages
}


// ── Update handler ────────────────────────────────────────────────────────────

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from: { id: number; username?: string; first_name?: string; is_bot?: boolean }
        chat: { id: number; type: string }
        date: number
        text?: string
        voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
        audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number; title?: string }
        video_note?: { file_id: string; duration: number; file_size?: number }
        photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
        document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
        sticker?: { file_id: string; emoji?: string }
        caption?: string
    }
    callback_query?: {
        id: string
        from: { id: number; username?: string; first_name?: string; is_bot?: boolean }
        message?: { message_id: number; chat: { id: number; type: string } }
        data: string
    }
    /** Internal flag: set when a voice message was transcribed and re-dispatched as text. */
    _fromVoice?: boolean
}

async function handleUpdate(channelId: string, entry: ChannelEntry, update: TelegramUpdate): Promise<void> {
    const { token, workspaceId } = entry

    // ── Inline button callbacks (legacy — no longer used, kept for graceful handling) ──
    if (update.callback_query) {
        const cb = update.callback_query
        if (cb.from.is_bot) return
        const chatId = String(cb.message?.chat.id)
        // Dismiss the button spinner immediately so it doesn't appear to hang
        await fetch(`${TELEGRAM_API}${token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: 'Button expired' }),
            signal: AbortSignal.timeout(5_000),
        }).catch((err: unknown) => logger.warn({ err, cbId: cb.id }, 'answerCallbackQuery failed'))
        await sendMessage(token, chatId, 'That button has expired. Send a new message instead.', { workspaceId })
        return
    }

    // ── Regular message ───────────────────────────────────────────────────────
    const msg = update.message
    if (!msg) return

    // Ignore bot-originated messages to prevent relay loops
    if (msg.from.is_bot) return

    const chatId = String(msg.chat.id)
    const channelRef: ChannelRef = { channel: 'telegram', channelId, chatId }
    // Universal session resolver is called AFTER text is extracted (see below)
    // so it can factor the message content into topic continuity decisions.
    let sessionId = ''
    let _sessionBreakReason: string = 'pending'
    let _newMessageEmbedding: number[] | null = null
    const attachments: { url: string; type: string; alt?: string }[] = []

    // ── Photo / Image ─────────────────────────────────────────────────────────
    // Download the image bytes and encode as a data URI so downstream AI
    // providers (Anthropic, OpenAI, etc.) receive the pixels inline instead
    // of a Telegram CDN URL they cannot fetch (blocked by robots.txt).
    const photos = msg.photo
    if (photos && photos.length > 0) {
        try {
            const largest = photos[photos.length - 1]!
            const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${largest.file_id}`)
            const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } }
            const filePath = fileInfo.result?.file_path

            if (filePath) {
                const imageRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
                if (!imageRes.ok) throw new Error(`Telegram image download returned ${imageRes.status}`)
                const imageBuffer = Buffer.from(await imageRes.arrayBuffer())
                // Telegram photos are always JPEG
                const dataUri = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                attachments.push({
                    url: dataUri,
                    type: 'image',
                    alt: msg.caption || 'Telegram photo'
                })
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to process Telegram photo')
            // Don't let a download failure produce a confusing "can't process that message type" later
            await sendMessage(token, chatId, 'Failed to download your image from Telegram. Try sending it again.', { workspaceId })
            return
        }
    }

    // ── Document-as-image ──────────────────────────────────────────────────────
    // Telegram sends screenshots, forwarded images, and uncompressed photos
    // as `document` with an image MIME type. Handle them identically to photos.
    const doc = msg.document
    if (doc && !attachments.length && doc.mime_type?.startsWith('image/')) {
        try {
            const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${doc.file_id}`)
            const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } }
            const filePath = fileInfo.result?.file_path

            if (filePath) {
                const imageRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
                if (!imageRes.ok) throw new Error(`Telegram document image download returned ${imageRes.status}`)
                const imageBuffer = Buffer.from(await imageRes.arrayBuffer())
                const mimeType = doc.mime_type || 'image/jpeg'
                const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
                attachments.push({
                    url: dataUri,
                    type: 'image',
                    alt: msg.caption || doc.file_name || 'Telegram image'
                })
            }
        } catch (err) {
            logger.warn({ err, mimeType: doc.mime_type, fileName: doc.file_name }, 'Failed to process Telegram document-as-image')
            await sendMessage(token, chatId, 'Failed to download your image from Telegram. Try sending it again.', { workspaceId })
            return
        }
    }

    // ── Voice / Audio / Video note ────────────────────────────────────────────
    // Telegram sends three flavours of speech payload:
    //   msg.voice       — push-to-talk OGG/OPUS voice memo
    //   msg.audio       — uploaded audio file (mp3, m4a, ogg, …)
    //   msg.video_note  — round "video message" (mp4; Deepgram reads the audio
    //                     track from the container just fine)
    //
    // We download the bytes directly from Telegram's file CDN, then call the
    // shared Deepgram lib in-process. DO NOT loopback-fetch /api/v1/voice/* —
    // that endpoint lives behind requireAuth and a server-to-server loopback
    // carries no session cookie, so it returns 401 and the user sees the
    // "set up Deepgram" nag even when Deepgram is fully configured (the
    // original bug this code path replaces).
    const voiceFile = msg.voice ?? msg.audio ?? msg.video_note
    if (voiceFile && !msg.text) {
        const voiceSettings = await loadVoiceSettings(workspaceId).catch((err) => {
            logger.error({ err, workspaceId, chatId }, 'Failed to load voice settings for Telegram audio')
            return null
        })

        // Only nag the user up-front if NO transcription provider is configured
        // anywhere (Deepgram voice settings, Deepgram connection, or Groq). The
        // orchestrator transparently falls back Deepgram → Groq, so the
        // presence of either is enough to proceed.
        if (!voiceSettings?.deepgramApiKey && !(await hasAnyTranscriptionProvider(workspaceId))) {
            await sendMessage(token, chatId,
                '🎙️ To transcribe voice messages, set up Deepgram (free $200 credits) in your Plexo dashboard.\n\n'
                + 'Go to *Settings → Voice* and add your API key from console.deepgram.com', { workspaceId })
            return
        }

        await sendTyping(token, chatId)
        let transcript: string | null = null
        try {
            // 1. Ask Telegram for the file path for this file_id
            const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${voiceFile.file_id}`, {
                signal: AbortSignal.timeout(10_000),
            })
            const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } }
            const filePath = fileInfo.result?.file_path
            if (!filePath) throw new Error('Could not get file path from Telegram')

            // 2. Download the OGG/OPUS (or mp3/mp4) bytes
            const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
                signal: AbortSignal.timeout(30_000),
            })
            if (!audioRes.ok) throw new Error(`Telegram file download returned ${audioRes.status}`)

            const audioBuffer = Buffer.from(await audioRes.arrayBuffer())
            // Telegram voice memos don't set mime_type on voice but on audio.
            // OGG/OPUS is Deepgram-compatible as 'audio/ogg'. Video notes are
            // mp4 containers — use 'video/mp4' so Deepgram reads the audio track.
            const mimeType: string = msg.voice?.mime_type
                ?? msg.audio?.mime_type
                ?? (msg.video_note ? 'video/mp4' : 'audio/ogg')

            // 3. Call the transcription orchestrator (iterates key candidates,
            //    skips known-bad keys via Redis cache, retries transient
            //    failures, and falls back to Groq Whisper on persistent errors).
            const result = await transcribeWithFallback(audioBuffer, mimeType, {
                workspaceId,
                chatId,
                source: 'telegram',
            })

            if (!result.ok) {
                logger.warn(
                    { workspaceId, chatId, code: result.code, message: result.message, mimeType, bytes: audioBuffer.length },
                    'Telegram voice transcription returned error',
                )
                if (result.code === 'NO_VOICE_KEY') {
                    await sendMessage(
                        token,
                        chatId,
                        '🎙️ No Deepgram API key configured. Go to *Settings → Voice* in your Plexo dashboard to add one.',
                        { workspaceId },
                    )
                } else if (result.code === 'INVALID_KEY') {
                    await sendMessage(
                        token,
                        chatId,
                        '🎙️ Your Deepgram API key is invalid or expired. Check your Deepgram dashboard and update the key in *Settings → Voice*.',
                        { workspaceId },
                    )
                } else {
                    await sendMessage(
                        token,
                        chatId,
                        'Had trouble processing that audio. Try again or send text instead.',
                        { workspaceId },
                    )
                }
                return
            }

            transcript = result.transcript.trim() || null

            if (!transcript) {
                logger.warn(
                    { workspaceId, chatId, bytes: audioBuffer.length },
                    'Deepgram returned empty transcript for non-zero audio buffer',
                )
                await sendMessage(token, chatId, '🎙️ I received your voice message but transcribed it as silence. Please speak clearly or send text.', { workspaceId })
                return
            }
            logger.info({ chatId, workspaceId, chars: transcript.length }, 'Telegram voice message transcribed')
        } catch (err) {
            logger.error({ err, chatId, workspaceId }, 'Telegram voice transcription failed')
            trackEvent('channel.error', 'error', { channel: 'telegram', error: 'voice_transcription_failed', workspaceId })
            const errMsg = err instanceof Error ? err.message.toLowerCase() : ''
            const detail = errMsg.includes('timeout') || errMsg.includes('etimedout')
                ? 'The transcription service timed out.'
                : errMsg.includes('401') || errMsg.includes('api key') || errMsg.includes('unauthorized')
                ? 'Deepgram API key issue — check Settings → Voice.'
                : errMsg.includes('econnrefused') || errMsg.includes('fetch failed')
                ? 'Could not reach the transcription service.'
                : 'Transcription failed unexpectedly.'
            await sendMessage(token, chatId, `Could not transcribe that voice message — ${detail} Try again or send text instead.`, { workspaceId })
            return
        }

        // Recurse with synthetic text message — downstream session / task
        // routing treats the transcript identically to a typed message.
        // _fromVoice flag tells the reply path to also send a TTS voice note.
        await handleUpdate(channelId, entry, {
            update_id: update.update_id,
            message: { ...msg, text: transcript, voice: undefined, audio: undefined, video_note: undefined },
            _fromVoice: true,
        })
        return
    }

    if (!msg.text && msg.caption) {
        msg.text = msg.caption
    }

    if (!msg.text && attachments.length === 0) {
        await sendMessage(token, chatId, "I can't process that message type yet (stickers, documents, locations, etc.).", { workspaceId })
        return
    }
    const text = msg.text?.trim() || (attachments.length > 0 ? '[Image]' : '')

    if (text === '/start') {
        const dashboardUrl = (process.env.PUBLIC_URL || 'https://getplexo.com') + '/app/settings/intelligence'
        await sendMessage(token, chatId,
            `Hey! I'm your Plexo AI agent. Here's what I can do:\n\n`
            + `- Answer questions and have conversations\n`
            + `- Process voice messages (auto-transcribed)\n`
            + `- Analyze images and photos (if a vision model is configured)\n`
            + `- Run tasks and projects in the background\n`
            + `- Search the web, manage files, and use connected tools\n\n`
            + `Send me a text, voice message, or photo to get started.\n\n`
            + `Manage your AI providers and settings: ${dashboardUrl}`,
            { workspaceId },
        )
        return
    }

    // ── Phase 4: CONFIRM / CANCEL routing for awaiting_confirmation tasks ────
    // Only short-circuits when the workspace actually has an awaiting_approval
    // task whose channelRef matches this chat. A casual "yes" with no pending
    // approval falls through to normal classification/dispatch below.
    {
        const { classifyConfirmCancel, handleInboundConfirmCancel } = await import('../channel-delivery.js')
        if (classifyConfirmCancel(text)) {
            const result = await handleInboundConfirmCancel({
                workspaceId,
                channel: 'telegram',
                chatId,
                text,
                decidedBy: `telegram:${msg.from.id}`,
            })
            if (result.outcome === 'approved') {
                await sendMessage(token, chatId, '✅ Confirmed — resuming the task.', { workspaceId })
                return
            }
            if (result.outcome === 'cancelled') {
                await sendMessage(token, chatId, '🚫 Cancelled.', { workspaceId })
                return
            }
            if (result.outcome === 'expired') {
                await sendMessage(token, chatId, '⌛ That confirmation already timed out or was resolved elsewhere.', { workspaceId })
                return
            }
            // 'no_pending' falls through to normal handling.
        }
    }

    // ── Universal session resolution ──────────────────────────────────────────
    // Decide which session this turn belongs to using the shared resolver.
    // Breaks on time gap / explicit phrase / task completion / topic change.
    try {
        const resolved = await resolveSessionId({
            workspaceId,
            channel: 'telegram',
            channelThreadId: chatId,
            userId: String(msg.from?.id ?? ''),
            newMessage: text,
        })
        sessionId = resolved.sessionId
        _sessionBreakReason = resolved.reason
        _newMessageEmbedding = resolved.newMessageEmbedding
        maybeResetHistory(channelId, chatId, resolved.isNewSession)
        if (resolved.isNewSession) {
            logger.info({ workspaceId, chatId, sessionId, reason: resolved.reason }, 'telegram: new session started')
        }
    } catch (err) {
        logger.warn({ err, chatId }, 'telegram: session resolver failed, using fallback id')
        sessionId = `telegram:${channelId}:${chatId}:${Date.now()}`
    }

    const _msgReceivedAt = Date.now()

    // Progress indicators: native typing action first, fallback to message for long tasks.
    let _replySent = false
    let _progressMessageId: number | null = null

    // Typing indicator: refresh every 4s (Telegram auto-expires at 5s).
    // This avoids sending a visible "Working on it" message for fast responses.
    const _typingInterval = setInterval(() => {
        if (_replySent) return
        void sendTyping(token, chatId)
    }, 4_000)

    // Safety net: show progress message only for genuinely long tasks (>15s).
    // First tick at 15s, then every 15s after. Hard cap at 3 min.
    const PROGRESS_HARD_CAP_MS = 180_000
    let _progressTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null

    const _progressTick = async () => {
        if (_replySent) return
        const elapsed = Math.round((Date.now() - _msgReceivedAt) / 1000)
        if (Date.now() - _msgReceivedAt > PROGRESS_HARD_CAP_MS) {
            if (_progressTimer) clearInterval(_progressTimer)
            _progressTimer = null
            return
        }
        if (!_progressMessageId) {
            _progressMessageId = await sendMessageGetId(token, chatId, `Working on it (${elapsed}s)…`)
        } else {
            await editMessage(token, chatId, _progressMessageId, `Working on it (${elapsed}s)…`).catch(() => null)
        }
    }
    // First tick after 15s, then every 15s
    _progressTimer = setTimeout(() => {
        void _progressTick()
        if (!_replySent) {
            _progressTimer = setInterval(() => void _progressTick(), 15_000)
        }
    }, 15_000)

    /** Stop all progress indicators. If cleanupProgress=true, delete the progress message entirely. */
    const _markReplied = async (cleanupProgress = true): Promise<void> => {
        _replySent = true
        clearInterval(_typingInterval)
        if (_progressTimer) { clearTimeout(_progressTimer as ReturnType<typeof setTimeout>); clearInterval(_progressTimer as ReturnType<typeof setInterval>) }
        _progressTimer = null
        // Delete the progress message entirely — no residue in chat.
        // For TASK intent, skip cleanup — the onAgentEvent handler takes ownership of the progress message.
        if (cleanupProgress && _progressMessageId) {
            await deleteMessageSilent(token, chatId, _progressMessageId).catch(() => null)
        }
    }

    // Check AI provider before doing anything else
    const { credential } = await loadWorkspaceAISettings(workspaceId)
    if (!credential) {
        await _markReplied()
        const providerUrl = (process.env.PUBLIC_URL || 'https://getplexo.com') + '/app/settings/intelligence'
        await sendMessage(token, chatId,
            `No AI provider configured yet. Add an API key (Anthropic, OpenAI, Groq, DeepSeek, or others) in your dashboard:\n\n${providerUrl}`,
            { workspaceId },
        )
        return
    }

    const imageUrls = attachments.filter(a => a.type === 'image').map(a => a.url)
    addToHistory(channelId, chatId, 'user', text, imageUrls.length > 0 ? imageUrls : undefined)
    await sendTyping(token, chatId)

    // ── Self-configuration: detect credentials and auto-install connection ──────
    // When a user pastes a URL + token, install immediately without confirmation.
    // This is the primary self-configuration mechanism for the system.
    const credMatch = detectCredentialMessage(text)
    if (credMatch) {
        await _markReplied()
        try {
            const reply = await autoInstallConnection(workspaceId, credMatch)
            addToHistory(channelId, chatId, 'assistant', reply)
            await sendMessage(token, chatId, reply, { workspaceId })
            void recordConversation({ workspaceId, sessionId, source: 'telegram', message: text, reply, status: 'complete', intent: 'CONVERSATION', channelRef, messageEmbedding: _newMessageEmbedding }).catch(err => logger.warn({ err }, 'recordConversation failed'))
        } catch (err) {
            logger.error({ err, workspaceId }, 'Auto-install integration failed')
            const errReply = `Failed to connect to ${credMatch.serviceName}. Check that the URL and token are correct.`
            await sendMessage(token, chatId, errReply, { workspaceId })
        }
        return
    }

    // ── Follow-up bypass: skip classification for obvious post-task follow-ups ──
    const recentCompletion = getRecentCompletion(channelId, chatId)
    if (recentCompletion && isFollowUpMessage(text, recentCompletion)) {
        await _markReplied()
        logger.info({ chatId, taskId: recentCompletion.taskId, text }, 'Telegram: follow-up detected — delivering results directly')
        const deliverableContent = await readTaskAssets(recentCompletion.taskId)
        if (deliverableContent) {
            const chunks = splitForTelegram(deliverableContent)
            for (const chunk of chunks) {
                await sendMessage(token, chatId, chunk, { workspaceId })
            }
            addToHistory(channelId, chatId, 'assistant', deliverableContent.slice(0, 500))
            void recordConversation({
                workspaceId,
                sessionId,
                source: 'telegram',
                message: text,
                reply: `[Delivered results — ${deliverableContent.length} chars]`,
                status: 'complete',
                intent: 'CONVERSATION',
                channelRef,
                messageEmbedding: _newMessageEmbedding,
            }).catch(err => logger.warn({ err }, 'recordConversation failed'))
        } else {
            // No asset content — resend the summary
            await sendMessage(token, chatId, recentCompletion.summary, { workspaceId })
            addToHistory(channelId, chatId, 'assistant', recentCompletion.summary)
            void recordConversation({
                workspaceId,
                sessionId,
                source: 'telegram',
                message: text,
                reply: recentCompletion.summary,
                status: 'complete',
                intent: 'CONVERSATION',
                channelRef,
                messageEmbedding: _newMessageEmbedding,
            }).catch(err => logger.warn({ err }, 'recordConversation failed'))
        }
        return
    }

    // ── Cross-session memory recall ─────────────────────────────────────────
    // Two triggers:
    // 1. Explicit recall intent (pattern match) — search by keywords or recent
    // 2. Young session (≤2 messages) — always inject recent prior context because
    //    the user is likely continuing from a previous conversation. This handles
    //    the semantic concept of "referencing something from before" without needing
    //    to enumerate every possible phrase.
    // resolveSessionId is called with channelThreadId=chatId, so the resolver
    // mints session IDs as 'telegram:{chatId}:{ulid}'. The prefix must match
    // that format so getOrHydrate recovers DB history correctly on restart.
    const sessionPrefix = `telegram:${chatId}:`
    let history: import('../channel-ai.js').ChatMessage[]
    let intent: import('../channel-ai.js').IntentLabel
    let suggestTask = false
    let isMemoryInstruction = false
    try {
        history = await chatHistory.getOrHydrate(historyKey(channelId, chatId), workspaceId, sessionPrefix)
        const classified = await classifyIntent(workspaceId, history)
        intent = classified.intent
        suggestTask = classified.suggestTask
        isMemoryInstruction = classified.isMemoryInstruction ?? false
    } catch (err) {
        await _markReplied()
        logger.error({ err, chatId, workspaceId }, 'Telegram: failed during history hydration or classification')
        const errMsg = err instanceof Error ? err.message.toLowerCase() : ''
        const detail = errMsg.includes('database') || errMsg.includes('connect') || errMsg.includes('pool')
            ? 'Database connection issue.'
            : errMsg.includes('classify') || errMsg.includes('intent')
            ? 'Intent classification failed.'
            : 'System error.'
        await sendMessage(token, chatId, `Failed to load conversation history — ${detail} Try sending your message again.`, { workspaceId })
        return
    }

    try {

    // ── Acknowledge receipt immediately with an emoji reaction ──────────
    // Fires before any AI processing so the user sees instant feedback.
    maybeReact(
        { channel: 'telegram', workspaceId, messageText: text, intent, isError: false },
        { channel: 'telegram', telegramToken: token, telegramChatId: chatId, telegramMessageId: msg.message_id },
    )

    // ── Memory instruction shortcut ─────────────────────────────────────
    // classifyIntent flagged this as an explicit behavioral instruction
    // ("remember X", "always Y", "never Z"). Store it and acknowledge without
    // routing to chatWithAI — which would answer but never persist anything.
    if (isMemoryInstruction) {
        const memReply = "Got it — I'll remember that."
        try {
            const { rememberInstruction } = await import('@plexo/agent/memory/store')
            await rememberInstruction({ workspaceId, instruction: text, source: 'telegram' })
        } catch (memErr) {
            logger.warn({ err: memErr, workspaceId }, 'Telegram: failed to store memory instruction')
        }
        addToHistory(channelId, chatId, 'assistant', memReply)
        await _markReplied()
        await sendMessage(token, chatId, memReply, { workspaceId })
        void recordConversation({ workspaceId, sessionId, source: 'telegram', message: text, reply: memReply, status: 'complete', intent: 'CONVERSATION', channelRef, messageEmbedding: _newMessageEmbedding }).catch((e: Error) => logger.warn({ e }, 'Telegram: recordConversation failed (MEMORY)'))
        return
    }

    if (intent === 'CONVERSATION') {
        // ── Correction feedback loop: detect and record user corrections ──
        try {
            const { hasCorrectionIntent, recordCorrection } = await import('@plexo/agent/memory/corrections')
            if (hasCorrectionIntent(text)) {
                const lastAssistant = history.filter(m => m.role === 'assistant').pop()?.content
                if (lastAssistant) {
                    const recentComp = getRecentCompletion(channelId, chatId)
                    void recordCorrection({
                        workspaceId,
                        originalOutput: lastAssistant,
                        correctionType: 'explicit_rejection',
                        userMessage: text,
                    }).catch((e: unknown) => logger.warn({ err: e }, 'Correction recording failed'))
                    // Quality analytics — correction type only, no content
                    const { emitUserCorrection } = await import('../analytics/events.js')
                    emitUserCorrection({ correctionType: 'explicit_rejection', hadRecentTask: !!recentComp })
                    // Surface in CC Errors for triage
                    try {
                        const { trackError } = await import('../event-tracker.js')
                        trackError(new Error(`User correction (Telegram): ${text.slice(0, 100)}`), {
                            workspaceId, category: 'user_correction', channel: 'telegram',
                            userMessage: text.slice(0, 300), agentResponse: lastAssistant?.slice(0, 300),
                        })
                    } catch { /* non-fatal */ }
                }
            }
        } catch { /* corrections module not available — non-fatal */ }

        const recentCompletion = getRecentCompletion(channelId, chatId)
        let channelContext = `\nChannel: Telegram. "Here" means this chat. If something just completed, the user may want the results delivered in this conversation.`
            + `\n\nVoice pipeline: Voice messages from the user are automatically transcribed (via Deepgram) before reaching you — you receive the transcript as text. When the user sent a voice message, your text reply is automatically synthesized to a voice note and sent back. You DO support voice — never say you can't process voice or audio. If the transcript seems wrong, ask the user to repeat or rephrase.`
        // Only inject the recently-completed task summary when the conversation is
        // new (≤1 turn) AND the user's message shares keywords with the task.
        // Without the keyword check, an unrelated task completion (e.g. SEO audit)
        // gets injected when the user asks about something else (e.g. Deepgram),
        // causing the model to answer about the wrong task — the ghost response bug.
        if (recentCompletion && history.length <= 1 && isMessageRelatedToCompletion(recentCompletion.summary, text)) {
            channelContext += `\n\nJust completed: "${recentCompletion.summary}". If the user asks about results, tell them you'll send the content directly.`
        }
        // SCL context expansion is handled inside chatWithAI (channel-ai.ts) for all
        // channels — do not expand here or the system prompt receives it twice.

        const result = await chatWithAI(
            workspaceId,
            history,
            buildConversationSystemPrompt('telegram', channelContext, { reactionsAvailable: true }),
            true,
            undefined,
            { channel: 'telegram', chatId, messageId: msg.message_id, botToken: token },
        )
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        let replyText = (result.text && result.text.trim())
            ? result.text
            : result.error
                ? translateErrorForUser(result.error)
                : "I wasn't able to generate a response for that. Could you rephrase or try again?"
        if (suggestTask && !result.error) replyText += TASK_SUGGEST_HINT
        await _markReplied()
        addToHistory(channelId, chatId, 'assistant', replyText)

        // Send FIRST, then record — if delivery fails, we don't log a phantom "complete"
        await sendMessage(token, chatId, replyText, { workspaceId })

        await recordConversation({
            workspaceId,
            sessionId,
            source: 'telegram',
            message: text,
            reply: replyText,
            status: result.error ? 'failed' : 'complete',
            errorMsg: result.error ? `AI error: ${result.error}` : null,
            intent: 'CONVERSATION',
            channelRef,
            attachments: attachments.length > 0 ? attachments : undefined,
            messageEmbedding: _newMessageEmbedding,
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Telegram conversation'))

        // ── Vision nudge: one-time prompt when images fail due to no vision model ──
        // If the user sent images and the reply indicates vision is unavailable,
        // send a follow-up with a direct link to fix it in the dashboard.
        if (imageUrls.length > 0 && replyText.includes("can't") && (replyText.includes('image') || replyText.includes('vision'))) {
            const nudgeKey = `plexo:vision-nudge:${workspaceId}`
            // Rate-limit: only nudge once per 24h per workspace via Redis or in-memory
            if (!_visionNudgeSent.has(nudgeKey)) {
                _visionNudgeSent.add(nudgeKey)
                // Clear after 24h so we nudge again if still not fixed
                setTimeout(() => _visionNudgeSent.delete(nudgeKey), 24 * 60 * 60 * 1000)
                const dashboardUrl = (process.env.PUBLIC_URL || 'https://getplexo.com') + '/app/settings/intelligence'
                await sendMessage(token, chatId,
                    `*Set up image processing:* Add a vision-capable provider (Claude, GPT-4o, Gemini, or Groq with a vision model) in your dashboard:\n\n`
                    + `${dashboardUrl}\n\n`
                    + `Once connected, I'll be able to see and analyze images you send.`,
                    { workspaceId },
                )
            }
        }

        // ── TTS voice note: when the original message was voice, speak the reply back ──
        if (update._fromVoice) {
            void (async () => {
                try {
                    const audio = await synthesizeSpeech(workspaceId, replyText)
                    if (audio) {
                        await sendVoice(token, chatId, audio)
                    }
                } catch (err) {
                    logger.warn({ err, chatId, workspaceId }, 'TTS voice reply failed — text already sent')
                }
            })()
        }

        // Reaction already sent above (before AI processing)

        // ── Fire-and-forget: conversation memory bridge ──────────────────
        // Runs AFTER response is sent — zero latency impact on the user.
        try {
            const { hasInstructionIntent, persistInstruction, extractConversationMemory } = await import('@plexo/agent/memory/conversation-bridge')
            if (hasInstructionIntent(text)) {
                void persistInstruction({ workspaceId, userMessage: text, assistantReply: replyText, sessionId })
                    .catch((e: unknown) => logger.warn({ err: e }, 'Instruction persistence failed'))
            }
            void extractConversationMemory({ workspaceId, userMessage: text, assistantReply: replyText, sessionId, source: 'telegram' })
                .catch((e: unknown) => logger.warn({ err: e }, 'Conversation memory extraction failed'))
        } catch { /* conversation-bridge module not available — non-fatal */ }

        // Quality analytics — response latency, no content
        try {
            const { emitConversationLatency } = await import('../analytics/events.js')
            emitConversationLatency({ source: 'telegram', latencyMs: Date.now() - _msgReceivedAt, modelFamily: 'unknown' })
        } catch { /* non-fatal */ }
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
        trackEvent('channel.conversation_turn', 'info', {
            channel: 'telegram',
            workspaceId,
            sessionId,
            intent: 'CONVERSATION',
            chatId: String(chatId),
            hasError: !!result.error,
        })
        return
    }

    // TASK or PROJECT: queue immediately — the user's message is the authorization.
    // Session IDs are now gap-based (SESSION_TIMEOUT_MS of inactivity), resolved
    // from the conversations table in telegramSessionId().

    const taskDescription = text

    const from = msg.from.username ?? msg.from.first_name ?? String(msg.from.id)

    // Stop progress interval but don't edit progress msg to '✓' —
    // the onAgentEvent handler takes ownership of the progress message for TASK/PROJECT.
    await _markReplied(false)

    if (intent === 'TASK') {
        try {
            const taskId = await pushTask({
                workspaceId,
                type: 'automation',
                source: 'telegram',
                context: {
                    description: taskDescription,
                    channel: 'telegram',
                    chatId,
                    from,
                    messageId: msg.message_id,
                    sessionId,
                    // Attach image URLs so the executor can send them to a
                    // vision-capable model. Empty-array safe.
                    ...(imageUrls.length > 0 ? { imageUrls } : {}),
                },
                priority: 2,
            })

            // Mark task immediately so channel-delivery.ts skips its duplicate progress reporter.
            // Must happen BEFORE the async sendMessageGetId call (which takes ~1s) so that
            // if the queue picks up the task during that window, isTaskDelivered returns true.
            markTaskDelivered(taskId)

            // Send ONE progress message upfront and store its ID so all subsequent
            // progress events edit it in-place. If the 15-second timer already sent a
            // progress message, reuse it (edit in-place) instead of creating a duplicate.
            if (_progressMessageId === null) {
                _progressMessageId = await sendMessageGetId(token, chatId, 'Working on it\u2026')
            } else {
                await editMessage(token, chatId, _progressMessageId, 'Working on it\u2026').catch(() => null)
            }

            // Reaction already sent above (before AI processing)

            let conversationId = ''
            try {
                conversationId = await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'telegram',
                    message: text,
                    reply: `Working on it\u2026`,
                    status: 'complete',
                    intent: 'TASK',
                    taskId,
                    channelRef,
                    attachments: attachments.length > 0 ? attachments : undefined,
                    messageEmbedding: _newMessageEmbedding,
                })
                emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
            } catch (err) {
                logger.error({ err, chatId }, 'Failed to record Telegram task conversation')
            }
            void conversationId // used for linkage if needed later

            trackEvent('channel.task_created', 'info', {
                channel: 'telegram',
                taskId,
                workspaceId,
                sessionId,
                chatId,
            })

            // Guard: once a terminal response (complete/failed) is sent, block further sends.
            // Prevents races where multiple terminal events arrive before unsub() takes effect.
            let _taskFinalSent = false

            const unsub = onAgentEvent(async (event) => {
                if (event.taskId !== taskId) return
                if (_taskFinalSent) return
                if (event.type === 'task_started') {
                    return
                }
                if (event.type === 'task_planning') {
                    if (_progressMessageId) {
                        await editMessage(token, chatId, _progressMessageId, 'Planning\u2026')
                    }
                    return
                }
                if (event.type === 'task_planned') {
                    const steps = event.steps as number | undefined
                    if (_progressMessageId) {
                        await editMessage(token, chatId, _progressMessageId,
                            steps && steps > 1 ? `Planning ${steps} steps\u2026` : 'Planning\u2026')
                    }
                    return
                }
                if (event.type === 'agent_step') {
                    const description = event.description as string | undefined
                    const toolName = event.tool as string | undefined
                    if (_progressMessageId) {
                        let text = description?.trim()
                        if (!text && toolName) {
                            const { describeToolCall } = await import('@plexo/agent/progress/tool-translations')
                            text = describeToolCall(toolName)
                        }
                        if (!text) text = 'Working on it'
                        await editMessage(token, chatId, _progressMessageId, `${text}\u2026`)
                    }
                    return
                }
                if (event.type === 'step.file_write') {
                    const path = event.path as string | undefined
                    const filename = path?.split('/').pop() ?? ''
                    if (_progressMessageId && filename) {
                        await editMessage(token, chatId, _progressMessageId, `Writing ${filename}\u2026`)
                    }
                    return
                }
                // Progress events: edit the single progress message in place.
                // _progressMessageId is always set before this handler fires
                // (set synchronously above via sendMessageGetId before pushTask
                // events can arrive), so no new-message fallback is needed.
                if (event.type === 'progress' && (event as any).eventType) {
                    const evType = (event as any).eventType as string
                    if (evType === 'phase_start' || evType === 'phase_complete' || evType === 'error') {
                        if (_progressMessageId) {
                            const { formatCompactProgress } = await import('@plexo/agent/progress/projector')
                            const progressText = formatCompactProgress(event as any)
                            await editMessage(token, chatId, _progressMessageId, progressText)
                        }
                    }
                    return
                }
                if (event.type === 'task_complete') {
                    _taskFinalSent = true
                    unsub()
                    // Use || not ?? so empty string ('') also falls through to the default.
                    // Executor early-exit paths (cost gate, OWD rejection) return outcomeSummary: ''
                    // which is not null/undefined and would silently bypass the ?? fallback.
                    const rawSummary = (event.summary as string | undefined) ?? (event.result as string | undefined)
                    const result = rawSummary?.trim() || 'Done.'
                    // Replace progress message with final result, or send new if too long.
                    // If editMessage fails (empty text, rate limit, message deleted), fall back to sendMessage.
                    if (_progressMessageId && result.length < 4000) {
                        const edited = await editMessage(token, chatId, _progressMessageId, result)
                        if (!edited) {
                            await sendMessage(token, chatId, result, { workspaceId })
                        }
                    } else {
                        // Clean up progress message before sending the real result
                        if (_progressMessageId) {
                            editMessage(token, chatId, _progressMessageId, '✓').catch(() => null)
                        }
                        await sendMessage(token, chatId, result, { workspaceId })
                    }
                    lastCompletedTask.set(`${channelId}:${chatId}`, {
                        taskId,
                        summary: result,
                        completedAt: Date.now(),
                    })
                    addToHistory(channelId, chatId, 'assistant', result)
                }
                // task_failed / task_blocked terminal events are owned by the
                // TASK_FAILED bus listener (channel-delivery.ts:initTaskFailedListener).
                // It renders the canonical 4-field escalation summary and dedups via
                // its own ownership check. Keeping a parallel in-memory failure path
                // here would either double-send or force a dedup gate that drops the
                // richer summary in favor of translateErrorForUser. Bus path wins.
            })
            setTimeout(async () => {
                // Listener gave up before the task reached a terminal state.
                // Clear the dedup flag so DB-backed delivery can deliver the
                // result when (if) the task eventually completes.
                if (!_taskFinalSent) {
                    const { unmarkTaskDelivered } = await import('../channel-delivery.js')
                    unmarkTaskDelivered(taskId)
                }
                unsub()
            }, 2 * 60 * 60 * 1000)

            emitToWorkspace(workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: text.slice(0, 200) })
        } catch (err) {
            logger.error({ err, chatId }, 'Failed to queue Telegram task')
            trackEvent('channel.error', 'error', { channel: 'telegram', error: 'task_queue_failed', chatId })
            const reason = err instanceof Error ? err.message : ''
            const detail = reason.toLowerCase().includes('database') || reason.toLowerCase().includes('pool')
                ? 'Database error while queuing.'
                : reason.toLowerCase().includes('timeout')
                ? 'Queue timed out.'
                : reason.length > 0
                ? reason.slice(0, 80)
                : 'Unknown queue error.'
            await sendMessage(token, chatId, `Failed to process that request — ${detail} Send it again or check Settings.`, { workspaceId })
        }
        return
    }

    if (intent === 'PROJECT') {
        try {
            const id = ulid()
            let projectName = text.slice(0, 80)
            try {
                const nameResult = await chatWithAI(workspaceId, [
                    { role: 'user', content: text },
                ], 'Create a short, descriptive project name (max 6 words) for this request. Return ONLY the name, no quotes. Example: "Q2 Social Media Campaign"')
                if (nameResult.text && nameResult.text.length > 2 && nameResult.text.length < 100) {
                    projectName = nameResult.text.replace(/^["']|["']$/g, '').trim()
                }
            } catch { /* fallback */ }

            const [sprint] = await db.insert(sprints).values({
                id,
                workspaceId,
                request: taskDescription,
                category: 'general',
                status: 'planning',
                metadata: { name: projectName, source: 'telegram', ...(imageUrls.length > 0 ? { imageUrls } : {}) },
            }).returning()

            await sendMessage(token, chatId, `Started: *${projectName}*`, { workspaceId })

            // Reaction already sent above (before AI processing)

            try {
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'telegram',
                    message: text,
                    reply: `Project created: ${projectName}`,
                    status: 'complete',
                    intent: 'PROJECT',
                    channelRef,
                    attachments: attachments.length > 0 ? attachments : undefined,
                    messageEmbedding: _newMessageEmbedding,
                })
                emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
            } catch (err) {
                logger.error({ err, chatId }, 'Failed to record Telegram project conversation')
            }

            trackEvent('channel.project_created', 'info', {
                channel: 'telegram',
                sprintId: sprint!.id,
                projectName,
                workspaceId,
                sessionId,
                chatId,
            })

            const sprintId = sprint!.id
            const unsub = onAgentEvent(async (event) => {
                if (event.type === 'sprint_status' && event.sprintId === sprintId) {
                    const status = event.status as string
                    if (status === 'complete') {
                        unsub()
                        void sendMessage(token, chatId, `Done — *${projectName}* is complete.`, { workspaceId }).catch((err: unknown) => logger.warn({ err, chatId }, 'failed to send sprint completion message'))
                    } else if (status === 'failed') {
                        unsub()
                        void sendMessage(token, chatId, translateErrorForUser((event.error as string) ?? ''), { workspaceId }).catch((err: unknown) => logger.warn({ err, chatId }, 'failed to send sprint failure message'))
                    } else if (status === 'cancelled') {
                        unsub()
                        void sendMessage(token, chatId, `*${projectName}* was cancelled.`, { workspaceId }).catch((err: unknown) => logger.warn({ err, chatId }, 'failed to send sprint cancelled message'))
                    }
                }
                if (event.type === 'sprint_deleted' && event.sprintId === sprintId) unsub()
            })
            setTimeout(() => unsub(), 24 * 60 * 60 * 1000)
        } catch (err) {
            logger.error({ err, chatId }, 'Failed to create Telegram project')
            trackEvent('channel.error', 'error', { channel: 'telegram', error: 'project_creation_failed', chatId })
            const reason = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
            await sendMessage(token, chatId, `Failed to create that project — ${reason}. Try sending your request again.`, { workspaceId })
        }
        return
    }

    } catch (err) {
        await _markReplied()
        logger.error({ err, chatId, workspaceId, channelId }, 'Telegram handler crashed — sending error to user')
        const reason = err instanceof Error ? err.message.slice(0, 100) : 'Unknown error'
        await sendMessage(token, chatId, `Failed to process that request — ${reason}. Send it again or check Settings → Intelligence.`, { workspaceId }).catch(() => null)
    }
}

// ── Webhook handler: /webhook/:channelId ──────────────────────────────────────

telegramRouter.post('/webhook/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params as { channelId: string }
    const secret = req.headers['x-telegram-bot-api-secret-token']

    // Telegram webhooks MUST include the secret token header — no header = reject.
    // Missing secret in env is also a misconfiguration and should hard-fail.
    if (!_webhookSecret) {
        logger.error({ channelId }, 'Telegram webhook hit but TELEGRAM_WEBHOOK_SECRET is not configured')
        res.status(503).json({ error: { code: 'INTERNAL_ERROR', message: 'Webhook not configured' } })
        return
    }
    const secretStr = typeof secret === 'string' ? secret : Array.isArray(secret) ? secret[0] : ''
    if (!secretStr || !timingSafeStringEqual(secretStr, _webhookSecret)) {
        logger.warn({ channelId, hasHeader: Boolean(secret) }, 'Telegram webhook secret mismatch or missing')
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
        return
    }

    const entry = _channels.get(channelId)
    if (!entry) {
        logger.warn({ channelId }, 'Telegram webhook hit for unknown channelId')
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown channel' } })
        return
    }

    const body = req.body as TelegramUpdate
    if (isDuplicateUpdate(body.update_id)) {
        logger.debug({ updateId: body.update_id, channelId }, 'Telegram webhook dedup — skipping duplicate update')
        res.json({ ok: true })
        return
    }

    res.json({ ok: true })
    handleUpdate(channelId, entry, body).catch(
        (err: Error) => logger.warn({ err, channelId }, 'Telegram update handler failed')
    )
})

// ── GET /info ─────────────────────────────────────────────────────────────────

telegramRouter.get('/info', (_req, res) => {
    res.json({
        configured: _channels.size > 0,
        channels: _channels.size,
        mode: process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes('localhost') ? 'webhook' : 'polling',
    })
})

// ── Token lookup (used by conversation-log reply-back) ────────────────────────

/**
 * Get the bot token for a channelId so chat.ts can relay web replies back to Telegram.
 */
export function getTelegramToken(channelId: string): string | null {
    return _channels.get(channelId)?.token ?? null
}

// ── Long polling (local dev) ──────────────────────────────────────────────────

let _pollingActive = false

async function startLongPolling(channelId: string, entry: ChannelEntry): Promise<void> {
    if (_pollingActive) return
    _pollingActive = true
    await deleteWebhook(entry.token)
    logger.info({ channelId }, 'Telegram long polling started (local dev mode)')

    let offset = 0
    let consecutiveErrors = 0
    const BASE_RETRY_MS = 15_000
    const MAX_RETRY_MS = 120_000
    while (_pollingActive) {
        try {
            const res = await fetch(
                `${TELEGRAM_API}${entry.token}/getUpdates?timeout=25&offset=${offset}`,
                { signal: AbortSignal.timeout(30_000) }
            )
            if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
            if (!data.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            if (consecutiveErrors > 0) {
                logger.info({ consecutiveErrors }, 'Telegram polling recovered')
            }
            consecutiveErrors = 0
            for (const update of data.result) {
                offset = update.update_id + 1
                handleUpdate(channelId, entry, update).catch(
                    (err: Error) => logger.warn({ err }, 'Telegram update handler failed')
                )
            }
        } catch (err: unknown) {
            if ((err as Error)?.name !== 'TimeoutError') {
                consecutiveErrors++
                const retryMs = Math.min(BASE_RETRY_MS * 2 ** (consecutiveErrors - 1), MAX_RETRY_MS)
                if (consecutiveErrors <= 3) {
                    logger.warn({ err, consecutiveErrors, retryMs }, 'Telegram polling error')
                } else {
                    logger.debug({ err, consecutiveErrors, retryMs }, 'Telegram polling error (repeated)')
                }
                await new Promise(r => setTimeout(r, retryMs))
            }
        }
    }
}

export function stopTelegramPolling(): void { _pollingActive = false }

// ── Init: called at startup and on channel create/update ──────────────────────

/**
 * Register a single Telegram channel. Idempotent — safe to call on update.
 * Sets the webhook to /webhook/:channelId so each bot is fully isolated.
 */
export async function registerTelegramChannel(
    channelId: string,
    token: string,
    workspaceId: string,
): Promise<void> {
    _channels.set(channelId, { token, workspaceId })
    // Register token for persistent channel delivery (survives restarts)
    const { registerChannelToken } = await import('../channel-delivery.js')
    registerChannelToken(workspaceId, token)
    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? _webhookSecret ?? null
    if (!_webhookSecret) {
        logger.error('TELEGRAM_WEBHOOK_SECRET is not set — refusing to register Telegram webhook')
        return
    }

    const publicUrl = process.env.PUBLIC_URL
    if (publicUrl && !publicUrl.includes('localhost')) {
        await setWebhook(
            token,
            `${publicUrl}/api/v1/channels/telegram/webhook/${channelId}`,
            _webhookSecret,
        )
    } else {
        // Local dev: only one bot can poll (Telegram limitation)
        if (!_pollingActive) {
            startLongPolling(channelId, { token, workspaceId }).catch(
                (err: Error) => logger.error({ err }, 'Telegram polling crashed')
            )
        }
    }
}

export async function initTelegramWebhook(): Promise<void> {
    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? null
    if (!_webhookSecret) {
        logger.warn('TELEGRAM_WEBHOOK_SECRET not set — Telegram webhooks will be rejected until configured')
    }

    const envToken = process.env.TELEGRAM_BOT_TOKEN
    if (envToken) {
        // Env-var override: treat as a synthetic channel with a fixed ID
        let wsId = process.env.DEFAULT_WORKSPACE_ID ?? ''
        if (!wsId) {
            // Auto-resolve: pick the first workspace so conversations are always linked
            try {
                const [row] = await db.execute<{ id: string }>(sql`SELECT id FROM workspaces LIMIT 1`)
                if (row?.id) wsId = row.id
            } catch { /* fall through with empty wsId */ }
            if (wsId) logger.info({ workspaceId: wsId }, 'Telegram env-default: auto-resolved workspace from DB')
            else logger.warn('Telegram env-default: no DEFAULT_WORKSPACE_ID and no workspaces in DB — conversations will be orphaned')
        }
        await registerTelegramChannel('env-default', envToken, wsId)
        return
    }

    // Retry up to 3 times with 2s delay — the DB pool may not be ready at cold start
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const rows = await db
                .select({ id: channels.id, config: channels.config, workspaceId: channels.workspaceId, enabled: channels.enabled })
                .from(channels)
                .where(eq(channels.type, 'telegram'))

            logger.info({ attempt, totalRows: rows.length, enabledRows: rows.filter(r => r.enabled).length }, 'Telegram init — DB query result')

            if (rows.length === 0) {
                if (attempt < 3) {
                    logger.info({ attempt }, 'No Telegram channels found — retrying in 2s (DB may not be ready)')
                    await new Promise(r => setTimeout(r, 2000))
                    continue
                }
                logger.info('No Telegram channels configured — adapter idle')
                return
            }

            let registered = 0
            for (const row of rows) {
                if (!row.enabled) {
                    logger.info({ channelId: row.id }, 'Telegram channel disabled — skipping')
                    continue
                }
                const { decryptSensitiveConfigKeys } = await import('../lib/channel-config-crypto.js')
                const cfg = decryptSensitiveConfigKeys('telegram', (row.config ?? {}) as Record<string, unknown>, row.workspaceId) as { token?: string; bot_token?: string }
                const token = cfg.token ?? cfg.bot_token ?? null
                if (token) {
                    await registerTelegramChannel(row.id, token, row.workspaceId)
                    registered++
                } else {
                    logger.warn({ channelId: row.id, configKeys: cfg ? Object.keys(cfg) : [] }, 'Telegram channel has no token in config')
                }
            }
            logger.info({ total: rows.length, registered }, 'Telegram channels initialised')
            return
        } catch (err) {
            if (attempt < 3) {
                logger.warn({ err, attempt }, 'Telegram init — DB query failed, retrying in 2s')
                await new Promise(r => setTimeout(r, 2000))
            } else {
                logger.error({ err }, 'Telegram init — DB lookup failed after 3 attempts')
            }
        }
    }
}
