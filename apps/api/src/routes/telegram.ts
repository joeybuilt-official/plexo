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
import { emitToWorkspace, onAgentEvent } from '../sse-emitter.js'
import { db, eq } from '@plexo/db'
import { channels, sprints } from '@plexo/db'
import { ulid } from 'ulid'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
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
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    }).catch((err: Error) => logger.warn({ err }, 'Telegram sendMessage failed'))
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
}

async function deleteWebhook(token: string): Promise<void> {
    await fetch(`${TELEGRAM_API}${token}/deleteWebhook`, { method: 'POST' }).catch(() => null)
}

// ── AI helpers ────────────────────────────────────────────────────────────────

interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface AiResult {
    text: string | null
    error: string | null
}

async function chatWithAI(workspaceId: string, messages: ChatMessage[], system?: string, includeSnapshot = false): Promise<AiResult> {
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) {
        return { text: null, error: 'no_credential' }
    }

    const providerKey = aiSettings.primaryProvider
    const config = aiSettings.providers[providerKey]
    if (!config) {
        return { text: null, error: `no config for provider ${providerKey}` }
    }

    try {
        let finalSystem = system ?? 'You are Plexo, an AI agent assistant.'
        
        if (includeSnapshot) {
            const { buildIntrospectionSnapshot } = await import('@plexo/agent/introspection')
            const resolvedModel = config.model ?? '(unknown)'
            const snapshot = await buildIntrospectionSnapshot(workspaceId, providerKey, resolvedModel)
            finalSystem += `\n\nYour identity: you are Plexo, running on provider "${providerKey}", model "${resolvedModel}". If asked what model, AI, or system you are, answer truthfully using this information. Never claim to be a different model or say you don't know.\n\nHere is your full state and self-awareness snapshot (tools, agents, skills, memory, integrations, channels, exact model, provider, and workspace):\n${JSON.stringify(snapshot, null, 2)}`
        }

        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const result = await generateText({
            model,
            system: finalSystem,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            abortSignal: AbortSignal.timeout(30_000),
        })
        return { text: result.text ?? null, error: null }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, workspaceId, providerKey }, 'Telegram AI chat call failed')
        return { text: null, error: msg }
    }
}

// ── Intent classification ─────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, or CONVERSATION.

TASK: The user is explicitly asking to start a clear, immediate, actionable task. Or the user is confirming (e.g. "yes", "do it") a previous proposal to create a task.
PROJECT: The user is explicitly asking to start a large, multi-step goal requiring planning (e.g., "Build a new features"). Or the user is confirming a proposal to create a project.
CONVERSATION: Vague requests, troubleshooting, requests needing clarification, greetings, checks, small talk, or rejecting proposals.

Reply with ONLY one word: TASK, PROJECT, or CONVERSATION.`

async function classifyIntent(workspaceId: string, history: ChatMessage[]): Promise<'TASK' | 'PROJECT' | 'CONVERSATION'> {
    const result = await chatWithAI(workspaceId, history, CLASSIFY_SYSTEM)
    if (result.error) return 'CONVERSATION'
    const resText = result.text?.trim().toUpperCase() ?? ''
    if (resText.startsWith('TASK')) return 'TASK'
    else if (resText.startsWith('PROJECT')) return 'PROJECT'
    return 'CONVERSATION'
}

// Per-chat conversation history (last 20 messages, scoped to channelId+chatId)
// In-memory warm cache — DB is the source of truth; this is rebuilt on demand.
const chatHistory = new Map<string, ChatMessage[]>()

function historyKey(channelId: string, chatId: string): string {
    return `${channelId}:${chatId}`
}

/** Stable session ID for a Telegram chat — used as conversations.session_id */
function telegramSessionId(channelId: string, chatId: string): string {
    return `telegram:${channelId}:${chatId}`
}

function addToHistory(channelId: string, chatId: string, role: 'user' | 'assistant', content: string): void {
    const key = historyKey(channelId, chatId)
    const hist = chatHistory.get(key) ?? []
    hist.push({ role, content })
    if (hist.length > 20) hist.splice(0, hist.length - 20)
    chatHistory.set(key, hist)
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

                    const unsub = onAgentEvent((event) => {
                        if (event.taskId !== taskId) return
                        if (event.type === 'task_complete') {
                            unsub()
                            const result = (event.result as string | undefined) ?? 'Done.'
                            sendMessage(token, chatId, `✅ ${result}`).catch(() => null)
                            addToHistory(channelId, chatId, 'assistant', result)
                            // Record the completion turn in conversations
                            recordConversation({
                                workspaceId,
                                sessionId: telegramSessionId(channelId, chatId),
                                source: 'telegram',
                                message: '[Task completed]',
                                reply: result,
                                status: 'complete',
                                intent: 'TASK',
                                taskId,
                                channelRef: { channel: 'telegram', channelId, chatId },
                            }).catch(() => null)
                        } else if (event.type === 'task_failed' || event.type === 'task_blocked') {
                            unsub()
                            const reason = (event.reason as string | undefined) ?? 'Unknown error'
                            sendMessage(token, chatId, `❌ ${reason}`).catch(() => null)
                            recordConversation({
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
                    setTimeout(() => unsub(), 5 * 60 * 1000)

                    emitToWorkspace(action.workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: action.description.slice(0, 200) })
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to queue Telegram task')
                    await sendMessage(token, chatId, '❌ Failed to queue task. Please try again.')
                }
            } else if (action.intent === 'PROJECT') {
                try {
                    const id = ulid()
                    const [sprint] = await db.insert(sprints).values({
                        id,
                        workspaceId: action.workspaceId,
                        request: action.description,
                        category: 'general',
                        status: 'planning',
                        metadata: {},
                    }).returning()

                    // Link sprint to conversation
                    if (action.conversationId && sprint) {
                        await linkTaskToConversation(action.conversationId, sprint.id).catch(() => null)
                    }

                    await sendMessage(token, chatId, `✅ Project created: _${sprint!.id}_. You can view it in the dashboard.`)
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to create Telegram project')
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

    if (!msg.text) return
    const text = msg.text.trim()

    if (text === '/start') {
        await sendMessage(token, chatId,
            '👋 Hi! I\'m *Plexo*, your AI agent.\n\n'
            + 'Tell me what you want done — I can research, write, build, automate, and more.\n\n'
            + 'Just describe the task in plain language.')
        return
    }

    // Check AI provider before doing anything else
    const { credential } = await loadWorkspaceAISettings(workspaceId)
    if (!credential) {
        await sendMessage(token, chatId, '⚠️ No AI provider configured. Add your API key in Settings → AI Providers.')
        return
    }

    addToHistory(channelId, chatId, 'user', text)
    await sendTyping(token, chatId)
    const history = chatHistory.get(historyKey(channelId, chatId)) ?? []

    const intent = await classifyIntent(workspaceId, history)

    if (intent === 'CONVERSATION') {
        const result = await chatWithAI(
            workspaceId,
            history,
            `You are Plexo, a helpful AI agent. Personality: Warm, sharp, direct. You get things done. Never hedge, over-explain, or ask unnecessary questions.

Critical rules — follow without exception:
1. NEVER ask for confirmation before answering. Just answer.
2. NEVER ask clarifying questions unless the request is genuinely ambiguous AND a reasonable assumption cannot be made.
3. Keep replies concise. No filler: no "Certainly!", "Of course!", "Great question!", "I'd be happy to help!".
4. If the user mentions a large initiative without supplying details, ALWAYS ask about strategy, timeline, goals, and ask if they'd like to start a project.
5. You are the agent. Act like one. Produce results, not process descriptions.
6. PROMPT OPTIMIZER: If the user asks you to optimize, improve, or write a prompt, DO NOT just write the prompt right away. Instead, act as a "first principles prompt optimizer": ask 2-3 specific, clarifying questions about their actual goals, context, target audience, and constraints. Only after they answer should you build the new optimized prompt.`,
            true
        )
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
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
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Telegram conversation'))

        await sendMessage(token, chatId, replyText)
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
        return
    }

    // TASK or PROJECT: ask for confirmation with inline buttons
    const actionId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const replyText = `Ready to create a **${intent === 'TASK' ? 'Task' : 'Project'}**.\n\nDescription: _${text.slice(0, 100)}${text.length > 100 ? '...' : ''}_\n\nProceed?`

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
        })
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'telegram' })
    } catch (err) {
        logger.error({ err, chatId }, 'Failed to record Telegram proposal conversation')
    }

    pendingActions.set(actionId, {
        channelId,
        token,
        workspaceId,
        intent,
        description: text,
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
    while (_pollingActive) {
        try {
            const res = await fetch(
                `${TELEGRAM_API}${entry.token}/getUpdates?timeout=25&offset=${offset}`,
                { signal: AbortSignal.timeout(30_000) }
            )
            if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
            if (!data.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            for (const update of data.result) {
                offset = update.update_id + 1
                handleUpdate(channelId, entry, update).catch(
                    (err: Error) => logger.warn({ err }, 'Telegram update handler failed')
                )
            }
        } catch (err: unknown) {
            if ((err as Error)?.name !== 'TimeoutError') {
                logger.warn({ err }, 'Telegram polling error')
                await new Promise(r => setTimeout(r, 5000))
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
        await registerTelegramChannel('env-default', envToken, process.env.DEFAULT_WORKSPACE_ID ?? '')
        return
    }

    try {
        const rows = await db
            .select({ id: channels.id, config: channels.config, workspaceId: channels.workspaceId })
            .from(channels)
            .where(eq(channels.type, 'telegram'))

        if (rows.length === 0) {
            logger.info('No Telegram channels configured — adapter idle')
            return
        }

        for (const row of rows) {
            const cfg = row.config as { token?: string; bot_token?: string } | null
            const token = cfg?.token ?? cfg?.bot_token ?? null
            if (token) {
                await registerTelegramChannel(row.id, token, row.workspaceId)
            }
        }
        logger.info({ count: rows.length }, 'Telegram channels initialised')
    } catch (err) {
        logger.error({ err }, 'Telegram init — DB lookup failed')
    }
}
