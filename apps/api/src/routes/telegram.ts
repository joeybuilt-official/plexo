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
import { pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'
import { emitToWorkspace, onAgentEvent } from '../sse-emitter.js'
import { db, eq, sql } from '@plexo/db'
import { channels, sprints } from '@plexo/db'
import { ulid } from 'ulid'
import { chatWithAI, classifyIntent, ChannelChatHistory, hasRecallIntent, recallPriorConversation } from '../channel-ai.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import {
    recordConversation,
    linkTaskToConversation,
    type ChannelRef,
} from '../conversation-log.js'

export const telegramRouter: RouterType = Router()

// ── Per-channel registry ──────────────────────────────────────────────────────

interface ChannelEntry {
    token: string
    workspaceId: string
}

/** channelId → { token, workspaceId } */
const _channels = new Map<string, ChannelEntry>()

let _webhookSecret: string | null = null

// ── Telegram API helpers ──────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot'

async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
    try {
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.error({ status: res.status, body, chatId }, 'Telegram sendMessage HTTP error')
            // Retry without Markdown parse_mode — Telegram rejects malformed Markdown
            if (res.status === 400 && body.includes('parse')) {
                const retry = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text }),
                })
                if (!retry.ok) logger.error({ status: retry.status }, 'Telegram sendMessage plain-text retry also failed')
            }
        }
    } catch (err) {
        logger.error({ err, chatId }, 'Telegram sendMessage network error')
    }
}

async function sendTyping(token: string, chatId: number | string): Promise<void> {
    await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => null)
}

async function setWebhook(token: string, url: string, secret: string): Promise<void> {
    const res = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret }),
    })
    const data = await res.json() as { ok: boolean; description?: string }
    if (data.ok) logger.info({ url }, 'Telegram webhook registered')
    else logger.error({ description: data.description }, 'Telegram webhook registration failed')
    if (!data?.ok) captureLifecycleEvent('channel.error', 'error', { channel: 'telegram', error: 'webhook_registration_failed' })
}

async function deleteWebhook(token: string): Promise<void> {
    await fetch(`${TELEGRAM_API}${token}/deleteWebhook`, { method: 'POST' }).catch(() => null)
}

// ── Chat history (shared helper from channel-ai.ts) ────────────────────────

const chatHistory = new ChannelChatHistory()

function historyKey(channelId: string, chatId: string): string {
    return `${channelId}:${chatId}`
}

/**
 * Session ID for a Telegram chat — used as conversations.session_id.
 *
 * Sessions auto-split after SESSION_GAP_MS of inactivity so that each
 * distinct conversation appears as a separate entry in the conversations list.
 * The epoch counter resets when there's a long silence between messages.
 */
const SESSION_GAP_MS = 30 * 60 * 1000 // 30 minutes
const sessionState = new Map<string, { epoch: number; lastActivity: number }>()

function telegramSessionId(channelId: string, chatId: string): string {
    const key = `${channelId}:${chatId}`
    const now = Date.now()
    let state = sessionState.get(key)
    if (!state) {
        state = { epoch: 0, lastActivity: now }
        sessionState.set(key, state)
    } else if (now - state.lastActivity > SESSION_GAP_MS) {
        state.epoch++
        state.lastActivity = now
        // Clear chat history so the AI starts fresh for the new session
        chatHistory.delete(key)
    } else {
        state.lastActivity = now
    }
    return `telegram:${channelId}:${chatId}:${state.epoch}`
}

function addToHistory(channelId: string, chatId: string, role: 'user' | 'assistant', content: string): void {
    chatHistory.add(historyKey(channelId, chatId), role, content)
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
]

function isFollowUpMessage(text: string, recentCompletion: CompletedTaskInfo | null): boolean {
    if (!recentCompletion) return false
    const trimmed = text.trim()
    if (trimmed.length > 80) return false
    return FOLLOW_UP_PATTERNS.some(p => p.test(trimmed))
}

// ── Asset content reader ────────────────────────────────────────────────────

async function readTaskAssets(taskId: string): Promise<string | null> {
    try {
        const { readdirSync, readFileSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')
        const dir = `/tmp/plexo-assets/${taskId}`
        if (!existsSync(dir)) return null
        const files = readdirSync(dir).filter(f => !(/\.(png|jpg|jpeg|gif|webp)$/i.test(f)))
        if (files.length === 0) return null
        const parts: string[] = []
        for (const file of files) {
            const content = readFileSync(join(dir, file), 'utf8')
            if (files.length > 1) {
                parts.push(`--- ${file} ---\n${content}`)
            } else {
                parts.push(content)
            }
        }
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

// Pending confirmations scoped to channel (so the right bot replies)
// Now stores the conversationId so we can link taskId on confirm.
const pendingActions = new Map<string, {
    channelId: string
    token: string
    workspaceId: string
    intent: 'TASK' | 'PROJECT'
    description: string
    from?: string
    messageId?: number
    chatId: string
    conversationId: string   // NEW — ID of the conversations row for this proposal
}>()

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
        caption?: string
    }
    callback_query?: {
        id: string
        from: { id: number; username?: string; first_name?: string; is_bot?: boolean }
        message?: { message_id: number; chat: { id: number; type: string } }
        data: string
    }
}

async function handleUpdate(channelId: string, entry: ChannelEntry, update: TelegramUpdate): Promise<void> {
    const { token, workspaceId } = entry

    // ── Inline button callbacks ───────────────────────────────────────────────
    if (update.callback_query) {
        const cb = update.callback_query
        // Ignore bot-originated callbacks
        if (cb.from.is_bot) return

        const chatId = String(cb.message?.chat.id)
        const data = cb.data

        if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
            const isConfirm = data.startsWith('confirm_')
            const actionId = data.split('_')[1]
            if (!actionId) return
            const action = pendingActions.get(actionId)

            if (!action) {
                await sendMessage(token, chatId, '❌ This action has expired or was already handled.')
                return
            }
            // Only handle if this callback belongs to this channel
            if (action.channelId !== channelId) return
            pendingActions.delete(actionId)

            if (cb.message) {
                await fetch(`${TELEGRAM_API}${token}/editMessageReplyMarkup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: cb.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }),
                })
            }

            if (!isConfirm) {
                await sendMessage(token, chatId, 'Action cancelled.')
                return
            }

            if (action.intent === 'TASK') {
                try {
                    const taskId = await pushTask({
                        workspaceId: action.workspaceId,
                        type: 'automation',
                        source: 'telegram',
                        context: {
                            description: action.description,
                            channel: 'telegram',
                            chatId,
                            from: action.from ?? 'Unknown',
                            messageId: action.messageId,
                            sessionId: telegramSessionId(channelId, chatId),
                        },
                        priority: 2,
                    })

                    // Link the queued task back to the original proposal conversation row
                    if (action.conversationId) {
                        await linkTaskToConversation(action.conversationId, taskId).catch(() => null)
                    }

                    await sendMessage(token, chatId, `⏳ Queueing Task… _(${taskId.slice(0, 8)})_`)

                    captureLifecycleEvent('channel.task_created', 'info', {
                        channel: 'telegram',
                        taskId,
                        workspaceId: action.workspaceId,
                        sessionId: telegramSessionId(channelId, chatId),
                        conversationId: action.conversationId || undefined,
                        chatId,
                    })

                    const unsub = onAgentEvent(async (event) => {
                        if (event.taskId !== taskId) return
                        // Notify user when task transitions from queued to running
                        if (event.type === 'task_started') {
                            void sendMessage(token, chatId, `🚀 Task is running…`).catch(() => null)
                            return // don't unsub — wait for completion
                        }
                        if (event.type === 'task_complete') {
                            unsub()
                            const result = (event.summary as string | undefined) ?? (event.result as string | undefined) ?? 'Done.'
                            const assets = (event.assets as string[] | undefined) ?? []

                            // Track completion for follow-up detection
                            lastCompletedTask.set(`${channelId}:${chatId}`, {
                                taskId,
                                summary: result,
                                completedAt: Date.now(),
                            })

                            const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000'
                            const assetAttachments = assets.filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).map(f => ({
                                url: `${publicUrl}/api/v1/tasks/${taskId}/assets/${f}`,
                                type: 'image',
                                alt: f
                            }))

                            // Send image assets first
                            if (assetAttachments.length > 0) {
                                const photoRes = await fetch(`${TELEGRAM_API}${token}/sendPhoto`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: chatId,
                                        photo: assetAttachments[0]!.url,
                                        caption: `✅ ${result}`,
                                        parse_mode: 'Markdown'
                                    }),
                                }).catch(() => null)
                                if (photoRes && !photoRes.ok) {
                                    logger.error({ status: photoRes.status }, 'Telegram sendPhoto failed — falling back to text')
                                    await sendMessage(token, chatId, `✅ ${result}`)
                                }
                            } else {
                                void sendMessage(token, chatId, `✅ ${result}`).catch(() => null)
                            }

                            // Auto-deliver text asset content to the chat
                            const deliverableContent = await readTaskAssets(taskId)
                            if (deliverableContent) {
                                const chunks = splitForTelegram(deliverableContent)
                                for (const chunk of chunks) {
                                    await sendMessage(token, chatId, chunk)
                                }
                            }

                            addToHistory(channelId, chatId, 'assistant', result)
                            void recordConversation({
                                workspaceId,
                                sessionId: telegramSessionId(channelId, chatId),
                                source: 'telegram',
                                message: '[Task completed]',
                                reply: result,
                                status: 'complete',
                                intent: 'TASK',
                                taskId,
                                channelRef: { channel: 'telegram', channelId, chatId },
                                attachments: assetAttachments.length > 0 ? assetAttachments : undefined,
                            }).catch(() => null)
                        } else if (event.type === 'task_failed' || event.type === 'task_blocked') {
                            unsub()
                            const reason = (event.error as string | undefined) ?? (event.reason as string | undefined) ?? 'Unknown error'
                            void sendMessage(token, chatId, `❌ Task failed: ${reason}`).catch(() => null)
                            void recordConversation({
                                workspaceId,
                                sessionId: telegramSessionId(channelId, chatId),
                                source: 'telegram',
                                message: '[Task failed]',
                                errorMsg: reason,
                                status: 'failed',
                                intent: 'TASK',
                                taskId,
                                channelRef: { channel: 'telegram', channelId, chatId },
                            }).catch(() => null)
                        }
                    })
                    // 2 hour timeout — tasks that take longer than this are anomalous
                    setTimeout(() => unsub(), 2 * 60 * 60 * 1000)

                    emitToWorkspace(action.workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: action.description.slice(0, 200) })
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to queue Telegram task')
                    captureLifecycleEvent('channel.error', 'error', { channel: 'telegram', error: 'task_queue_failed', chatId })
                    await sendMessage(token, chatId, '❌ Failed to queue task. Please try again.')
                }
            } else if (action.intent === 'PROJECT') {
                try {
                    const id = ulid()
                    // Generate an AI-powered name for the project
                    let projectName = action.description.slice(0, 80)
                    try {
                        const nameResult = await chatWithAI(action.workspaceId, [
                            { role: 'user', content: action.description },
                        ], 'Create a short, descriptive project name (max 6 words) for this request. Return ONLY the name, no quotes. Example: "Q2 Social Media Campaign"')
                        if (nameResult.text && nameResult.text.length > 2 && nameResult.text.length < 100) {
                            projectName = nameResult.text.replace(/^["']|["']$/g, '').trim()
                        }
                    } catch { /* fallback to truncated raw text */ }

                    const [sprint] = await db.insert(sprints).values({
                        id,
                        workspaceId: action.workspaceId,
                        request: action.description,
                        category: 'general',
                        status: 'planning',
                        metadata: { name: projectName, source: 'telegram' },
                    }).returning()

                    // Link sprint to conversation
                    if (action.conversationId && sprint) {
                        await linkTaskToConversation(action.conversationId, sprint.id).catch(() => null)
                    }

                    await sendMessage(token, chatId, `✅ Project created: *${projectName}*\n\nYou can view it in the dashboard.`)

                    captureLifecycleEvent('channel.project_created', 'info', {
                        channel: 'telegram',
                        sprintId: sprint!.id,
                        projectName,
                        workspaceId: action.workspaceId,
                        sessionId: telegramSessionId(channelId, chatId),
                        conversationId: action.conversationId || undefined,
                        chatId,
                    })

                    // Subscribe to sprint lifecycle events so we notify Telegram on completion/failure
                    const sprintId = sprint!.id
                    const unsub = onAgentEvent(async (event) => {
                        // Sprint status events (complete, failed, cancelled)
                        if (event.type === 'sprint_status' && event.sprintId === sprintId) {
                            const status = event.status as string
                            if (status === 'complete') {
                                unsub()
                                const msg = `✅ Project completed.`
                                void sendMessage(token, chatId, msg).catch(() => null)
                                void recordConversation({
                                    workspaceId: action.workspaceId,
                                    sessionId: telegramSessionId(channelId, chatId),
                                    source: 'telegram',
                                    message: '[Project completed]',
                                    reply: msg,
                                    status: 'complete',
                                    intent: 'PROJECT',
                                    channelRef: { channel: 'telegram', channelId, chatId },
                                }).catch(() => null)
                            } else if (status === 'failed') {
                                unsub()
                                const reason = (event.error as string) ?? (event.message as string) ?? 'Unknown error'
                                const msg = `❌ Project failed: ${reason}`
                                void sendMessage(token, chatId, msg).catch(() => null)
                                void recordConversation({
                                    workspaceId: action.workspaceId,
                                    sessionId: telegramSessionId(channelId, chatId),
                                    source: 'telegram',
                                    message: '[Project failed]',
                                    errorMsg: reason,
                                    status: 'failed',
                                    intent: 'PROJECT',
                                    channelRef: { channel: 'telegram', channelId, chatId },
                                }).catch(() => null)
                            } else if (status === 'cancelled') {
                                unsub()
                                void sendMessage(token, chatId, `🚫 Project was cancelled.`).catch(() => null)
                            }
                        }
                        // Sprint deleted event (hard delete from dashboard)
                        if (event.type === 'sprint_deleted' && event.sprintId === sprintId) {
                            unsub()
                        }
                    })
                    // Auto-cleanup after 24h
                    setTimeout(() => unsub(), 24 * 60 * 60 * 1000)
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to create Telegram project')
                    captureLifecycleEvent('channel.error', 'error', { channel: 'telegram', error: 'project_creation_failed', chatId })
                    await sendMessage(token, chatId, '❌ Failed to create project. Please try again.')
                }
            }
        }
        return
    }

    // ── Regular message ───────────────────────────────────────────────────────
    const msg = update.message
    if (!msg) return

    // Ignore bot-originated messages to prevent relay loops
    if (msg.from.is_bot) return

    const chatId = String(msg.chat.id)
    const channelRef: ChannelRef = { channel: 'telegram', channelId, chatId }
    const sessionId = telegramSessionId(channelId, chatId)
    const attachments: { url: string; type: string; alt?: string }[] = []

    // ── Photo / Image ─────────────────────────────────────────────────────────
    const photos = msg.photo
    if (photos && photos.length > 0) {
        try {
            const largest = photos[photos.length - 1]!
            const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${largest.file_id}`)
            const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } }
            const filePath = fileInfo.result?.file_path
            
            if (filePath) {
                const imageUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
                attachments.push({ 
                    url: imageUrl, 
                    type: 'image', 
                    alt: msg.caption || 'Telegram photo' 
                })
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to process Telegram photo')
        }
    }

    // ── Voice / Audio ─────────────────────────────────────────────────────────
    const voiceFile = msg.voice ?? msg.audio ?? msg.video_note
    if (voiceFile && !msg.text) {
        const apiBase = `http://localhost:${process.env.PORT ?? 3001}`
        const settingsRes = await fetch(`${apiBase}/api/v1/voice/settings?workspaceId=${workspaceId}`, {
            signal: AbortSignal.timeout(5000),
        }).catch(() => null)
        const voiceSettings = settingsRes?.ok ? await settingsRes.json() as { configured: boolean } : null

        if (!voiceSettings?.configured) {
            await sendMessage(token, chatId,
                '🎙️ To transcribe voice messages, set up Deepgram (free $200 credits) in your Plexo dashboard.\n\n'
                + 'Go to *Settings → Voice* and add your API key from console.deepgram.com')
            return
        }

        await sendTyping(token, chatId)
        let transcript: string | null = null
        try {
            const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${voiceFile.file_id}`, {
                signal: AbortSignal.timeout(10_000),
            })
            const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } }
            const filePath = fileInfo.result?.file_path
            if (!filePath) throw new Error('Could not get file path from Telegram')

            const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
                signal: AbortSignal.timeout(30_000),
            })
            if (!audioRes.ok) throw new Error(`Telegram file download returned ${audioRes.status}`)

            const audioBuffer = Buffer.from(await audioRes.arrayBuffer())
            const mimeType = (msg.voice?.mime_type ?? msg.audio?.mime_type ?? 'audio/ogg') as string

            const transcribeRes = await fetch(`${apiBase}/api/v1/voice/transcribe?workspaceId=${workspaceId}`, {
                method: 'POST',
                headers: { 'Content-Type': mimeType },
                body: audioBuffer,
                signal: AbortSignal.timeout(35_000),
            }).catch(e => {
                logger.error({ err: e, workspaceId }, 'Failed to reach transcription API')
                throw e
            })

            if (!transcribeRes.ok) {
                const errorData = await transcribeRes.json().catch(() => ({})) as { error?: { message: string, code: string } }
                const msg = errorData.error?.message || `API returned ${transcribeRes.status}`
                logger.warn({ workspaceId, status: transcribeRes.status, errorData, mimeType }, 'Voice transcription API returned error')
                
                if (transcribeRes.status === 402 || (errorData.error?.code === 'NO_VOICE_KEY')) {
                    await sendMessage(token, chatId, '🎙️ No Deepgram API key found. Go to *Settings → Voice* in your Plexo dashboard to enable voice messages.')
                } else {
                    await sendMessage(token, chatId, `❌ Sorry, I had trouble processing that audio: ${msg}`)
                }
                return
            }

            const transcribeData = await transcribeRes.json() as { transcript?: string }
            transcript = transcribeData.transcript ?? null

            if (!transcript || transcript.trim() === '') {
                logger.warn({ workspaceId, chatId }, 'Deepgram returned empty transcript for non-zero audio buffer')
                await sendMessage(token, chatId, '🎙️ I received your voice message but transcribed it as silence. Please speak clearly or send text.')
                return
            }
            logger.info({ chatId, workspaceId, chars: transcript.length }, 'Telegram voice message transcribed')
        } catch (err) {
            logger.error({ err, chatId, workspaceId }, 'Telegram voice transcription failed')
            captureLifecycleEvent('channel.error', 'error', { channel: 'telegram', error: 'voice_transcription_failed', workspaceId })
            await sendMessage(token, chatId, '❌ Failed to transcribe your voice message. Please try again or send text.')
            return
        }

        // Recurse with synthetic text message
        await handleUpdate(channelId, entry, {
            update_id: update.update_id,
            message: { ...msg, text: transcript, voice: undefined, audio: undefined, video_note: undefined },
        })
        return
    }

    if (!msg.text && msg.caption) {
        msg.text = msg.caption
    }

    if (!msg.text && attachments.length === 0) return
    const text = msg.text?.trim() || (attachments.length > 0 ? '[Image]' : '')

    if (text === '/start') {
        await sendMessage(token, chatId,
            '👋 Hi! I\'m *Plexo*, your AI agent.\n\n'
            + 'Tell me what you want done — I can research, write, build, automate, and more.\n\n'
            + 'Just describe the task in plain language.')
        return
    }

    const _msgReceivedAt = Date.now()

    // Check AI provider before doing anything else
    const { credential } = await loadWorkspaceAISettings(workspaceId)
    if (!credential) {
        await sendMessage(token, chatId, '⚠️ No AI provider configured. Add your API key in Settings → AI Providers.')
        return
    }

    addToHistory(channelId, chatId, 'user', text)
    await sendTyping(token, chatId)

    // ── Follow-up bypass: skip classification for obvious post-task follow-ups ──
    const recentCompletion = getRecentCompletion(channelId, chatId)
    if (recentCompletion && isFollowUpMessage(text, recentCompletion)) {
        logger.info({ chatId, taskId: recentCompletion.taskId, text }, 'Telegram: follow-up detected — delivering results directly')
        const deliverableContent = await readTaskAssets(recentCompletion.taskId)
        if (deliverableContent) {
            const chunks = splitForTelegram(deliverableContent)
            for (const chunk of chunks) {
                await sendMessage(token, chatId, chunk)
            }
            addToHistory(channelId, chatId, 'assistant', deliverableContent.slice(0, 500))
            void recordConversation({
                workspaceId,
                sessionId,
                source: 'telegram',
                message: text,
                reply: `[Delivered task ${recentCompletion.taskId.slice(0, 8)} results — ${deliverableContent.length} chars]`,
                status: 'complete',
                intent: 'CONVERSATION',
                channelRef,
            }).catch(() => null)
        } else {
            // No asset content — resend the summary
            await sendMessage(token, chatId, recentCompletion.summary)
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
            }).catch(() => null)
        }
        return
    }

    // ── Cross-session memory recall ─────────────────────────────────────────
    const sessionPrefix = `telegram:${channelId}:${chatId}:`
    let recalledContext: string | null = null
    if (hasRecallIntent(text)) {
        try {
            recalledContext = await recallPriorConversation(workspaceId, text, sessionPrefix)
            if (recalledContext) {
                logger.info({ chatId, workspaceId, chars: recalledContext.length }, 'Telegram: recalled prior conversation context')
            }
        } catch (err) {
            logger.warn({ err, chatId }, 'Telegram: recall search failed — proceeding without')
        }
    }

    let history: import('../channel-ai.js').ChatMessage[]
    let intent: import('../channel-ai.js').IntentLabel
    try {
        history = await chatHistory.getOrHydrate(historyKey(channelId, chatId), workspaceId, sessionPrefix)
        intent = await classifyIntent(workspaceId, history)
    } catch (err) {
        logger.error({ err, chatId, workspaceId }, 'Telegram: failed during history hydration or classification')
        await sendMessage(token, chatId, 'Something went wrong processing your message. Try again in a moment.')
        return
    }

    try {

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
                    // Quality telemetry — correction type only, no content
                    const { emitUserCorrection } = await import('../telemetry/events.js')
                    emitUserCorrection({ correctionType: 'explicit_rejection', hadRecentTask: !!recentComp })
                }
            }
        } catch { /* corrections module not available — non-fatal */ }

        const recentCompletion = getRecentCompletion(channelId, chatId)
        let channelContext = `\nChannel context: The user is messaging you via Telegram. When they say "here" or "send it here", they mean this Telegram chat. If a task just completed, they may be asking for the results to be delivered in this conversation.`
        if (recentCompletion) {
            channelContext += `\n\nA task just completed in this chat (task ${recentCompletion.taskId.slice(0, 8)}): "${recentCompletion.summary}". If the user asks about results or wants to see the output, you can tell them you'll send the deliverable content directly.`
        }
        if (recalledContext) {
            channelContext += `\n\n${recalledContext}`
        }

        const result = await chatWithAI(
            workspaceId,
            history,
            `You are Plexo, a helpful AI agent. Personality: Warm, sharp, direct. You get things done. Never hedge, over-explain, or ask unnecessary questions.
${channelContext}

Critical rules — follow without exception:
1. NEVER ask for confirmation before answering. Just answer.
2. NEVER ask clarifying questions unless the request is genuinely ambiguous AND a reasonable assumption cannot be made.
3. Keep replies concise. No filler: no "Certainly!", "Of course!", "Great question!", "I'd be happy to help!".
4. If the user mentions a large initiative without supplying details, ALWAYS ask about strategy, timeline, goals, and ask if they'd like to start a project.
5. You are the agent. Act like one. Produce results, not process descriptions.
6. PROMPT OPTIMIZER: If the user asks you to optimize, improve, or write a prompt, DO NOT just write the prompt right away. Instead, act as a "first principles prompt optimizer": ask 2-3 specific, clarifying questions about their actual goals, context, target audience, and constraints. Only after they answer should you build the new optimized prompt.
7. PLAIN ENGLISH ONLY: Never list tool names in backticks or code formatting. Describe what you can do in plain language. You are talking to a person, not writing documentation.`,
            true
        )
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        const replyText = result.text ?? `⚠️ ${result.error ?? 'Unknown error — check Settings → AI Providers.'}`
        addToHistory(channelId, chatId, 'assistant', replyText)

        // Record every conversation turn
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
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Telegram conversation'))

        await sendMessage(token, chatId, replyText)
        // Quality telemetry — response latency, no content
        try {
            const { emitConversationLatency } = await import('../telemetry/events.js')
            emitConversationLatency({ source: 'telegram', latencyMs: Date.now() - _msgReceivedAt, modelFamily: 'unknown' })
        } catch { /* non-fatal */ }
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
        captureLifecycleEvent('channel.conversation_turn', 'info', {
            channel: 'telegram',
            workspaceId,
            sessionId,
            intent: 'CONVERSATION',
            chatId: String(chatId),
            hasError: !!result.error,
        })
        return
    }

    // TASK or PROJECT: start a fresh session epoch so this action gets its own conversation thread
    const chatKey = `${channelId}:${chatId}`
    const st = sessionState.get(chatKey)
    if (st) { st.epoch++; st.lastActivity = Date.now() }

    const actionId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    // AI-generate a meaningful title (max ~8 words) from the raw user input
    let summaryTitle = text.slice(0, 80)
    try {
        const titleResult = await chatWithAI(workspaceId, [
            { role: 'user', content: text },
        ], 'Summarise the user message into a short, descriptive title (max 8 words). Return ONLY the title, no quotes, no punctuation at the end. Example: "Create social media profiles for Plexo"')
        if (titleResult.text && titleResult.text.length > 2 && titleResult.text.length < 120) {
            summaryTitle = titleResult.text.replace(/^["']|["']$/g, '').trim()
        }
    } catch { /* fallback to truncated raw text */ }

    const replyText = `Ready to create a **${intent === 'TASK' ? 'Task' : 'Project'}**.\n\nDescription: _${summaryTitle}_\n\nProceed?`

    // Record the proposal as a conversation turn BEFORE sending the confirm prompt
    // so we can link the task/project ID back to it on confirmation.
    let conversationId = ''
    try {
        conversationId = await recordConversation({
            workspaceId,
            sessionId,
            source: 'telegram',
            message: text,
            reply: replyText,
            status: 'complete',
            intent,
            channelRef,
            attachments: attachments.length > 0 ? attachments : undefined,
        })
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
    } catch (err) {
        logger.error({ err, chatId }, 'Failed to record Telegram proposal conversation')
    }

    // When recall found prior context and this becomes a TASK/PROJECT,
    // append the recalled context to the description so the executor has it.
    const taskDescription = recalledContext
        ? `${text}\n\n${recalledContext}`
        : text

    pendingActions.set(actionId, {
        channelId,
        token,
        workspaceId,
        intent,
        description: taskDescription,
        from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
        messageId: msg.message_id,
        chatId,
        conversationId,
    })

    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: replyText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: `✅ Confirm`, callback_data: `confirm_${actionId}` },
                    { text: '❌ Cancel', callback_data: `cancel_${actionId}` }
                ]]
            }
        }),
    })

    } catch (err) {
        logger.error({ err, chatId, workspaceId, channelId }, 'Telegram handler crashed — sending error to user')
        await sendMessage(token, chatId, 'Something went wrong. Try again in a moment.').catch(() => null)
    }
}

// ── Webhook handler: /webhook/:channelId ──────────────────────────────────────

telegramRouter.post('/webhook/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params as { channelId: string }
    const secret = req.headers['x-telegram-bot-api-secret-token']

    if (_webhookSecret && secret !== _webhookSecret) {
        logger.warn({ channelId }, 'Telegram webhook secret mismatch')
        res.status(403).json({ error: 'Forbidden' })
        return
    }

    const entry = _channels.get(channelId)
    if (!entry) {
        logger.warn({ channelId }, 'Telegram webhook hit for unknown channelId')
        res.status(404).json({ error: 'Unknown channel' })
        return
    }

    res.json({ ok: true })
    handleUpdate(channelId, entry, req.body as TelegramUpdate).catch(
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
    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? _webhookSecret ?? 'plexo-telegram-prod'

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
    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? 'plexo-telegram-prod'

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
                const cfg = row.config as { token?: string; bot_token?: string } | null
                const token = cfg?.token ?? cfg?.bot_token ?? null
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
