/**
 * Telegram channel adapter.
 *
 * Architecture:
 * - Production: webhook (registered via PUBLIC_URL at startup)
 * - Local dev: long polling (getUpdates loop, no public URL needed)
 *
 * Message routing:
 * - Conversational messages → direct AI reply (no task queued)
 * - Task requests → queued, agent executes, replies when done
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { pushTask, completeTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace, onAgentEvent } from '../sse-emitter.js'
import { db, eq } from '@plexo/db'
import { channels, sprints } from '@plexo/db'
import { ulid } from 'ulid'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'

export const telegramRouter: RouterType = Router()

const pendingActions = new Map<string, { workspaceId: string, intent: 'TASK' | 'PROJECT', description: string, from?: string, messageId?: number }>()

const TELEGRAM_API = 'https://api.telegram.org/bot'

let _botToken: string | null = null
let _webhookSecret: string | null = null

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function sendMessage(chatId: number | string, text: string): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    }).catch((err: Error) => logger.warn({ err }, 'Telegram sendMessage failed'))
}

async function sendTyping(chatId: number | string): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => null)
}

async function setWebhook(url: string, secret: string): Promise<void> {
    if (!_botToken) return
    const res = await fetch(`${TELEGRAM_API}${_botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret }),
    })
    const data = await res.json() as { ok: boolean; description?: string }
    if (data.ok) logger.info({ url }, 'Telegram webhook registered')
    else logger.error({ description: data.description }, 'Telegram webhook registration failed')
}

async function deleteWebhook(): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/deleteWebhook`, { method: 'POST' }).catch(() => null)
}

// ── AI helpers (provider-agnostic, shared credential resolution) ─────────────

interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface AiResult {
    text: string | null
    error: string | null
}

/**
 * Provider-agnostic chat — uses the shared loadWorkspaceAISettings (same as agent-loop)
 * to resolve the correct provider + credential, then calls generateText via ai-sdk.
 */
async function chatWithAI(workspaceId: string, messages: ChatMessage[], system?: string): Promise<AiResult> {
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
        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const result = await generateText({
            model,
            system: system ?? 'You are Plexo, an AI agent assistant.',
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

// ── Workspace resolver ───────────────────────────────────────────────────────

const CHAT_TO_WORKSPACE = new Map<string, string>()

export function registerTelegramChat(chatId: string, workspaceId: string): void {
    CHAT_TO_WORKSPACE.set(chatId, workspaceId)
}

async function resolveWorkspace(chatId: string): Promise<string | null> {
    if (CHAT_TO_WORKSPACE.has(chatId)) return CHAT_TO_WORKSPACE.get(chatId)!
    const defaultWs = process.env.DEFAULT_WORKSPACE_ID ?? process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
    if (defaultWs) {
        CHAT_TO_WORKSPACE.set(chatId, defaultWs)
        return defaultWs
    }
    try {
        const [ch] = await db.select({ workspaceId: channels.workspaceId })
            .from(channels).where(eq(channels.type, 'telegram')).limit(1)
        if (ch?.workspaceId) {
            CHAT_TO_WORKSPACE.set(chatId, ch.workspaceId)
            return ch.workspaceId
        }
    } catch (err) { logger.warn({ err }, 'Telegram workspace DB lookup failed') }
    return null
}

// ── Intent classification ────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, or CONVERSATION.

TASK: The user is explicitly asking to start a clear, immediate, actionable task. Or the user is confirming (e.g. "yes", "do it") a previous proposal to create a task.
PROJECT: The user is explicitly asking to start a large, multi-step goal requiring planning (e.g., "Build a new features"). Or the user is confirming a proposal to create a project.
CONVERSATION: Vague requests, troubleshooting, requests needing clarification, greetings, checks, small talk, or rejecting proposals.

Reply with ONLY one word: TASK, PROJECT, or CONVERSATION.`

async function classifyIntent(workspaceId: string, history: ChatMessage[]): Promise<'TASK' | 'PROJECT' | 'CONVERSATION'> {
    const result = await chatWithAI(workspaceId, history, CLASSIFY_SYSTEM)
    // On AI error, default to CONVERSATION so the error path handles it
    if (result.error) return 'CONVERSATION'
    const resText = result.text?.trim().toUpperCase() ?? ''
    if (resText.startsWith('TASK')) return 'TASK'
    else if (resText.startsWith('PROJECT')) return 'PROJECT'
    return 'CONVERSATION'
}

// Per-chat conversation history (last 20 messages, in-memory)
const chatHistory = new Map<string, ChatMessage[]>()

function addToHistory(chatId: string, role: 'user' | 'assistant', content: string): void {
    const hist = chatHistory.get(chatId) ?? []
    hist.push({ role, content })
    if (hist.length > 20) hist.splice(0, hist.length - 20)
    chatHistory.set(chatId, hist)
}

// ── Update handler ───────────────────────────────────────────────────────────

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from: { id: number; username?: string; first_name?: string }
        chat: { id: number; type: string }
        date: number
        text?: string
    }
    callback_query?: {
        id: string
        from: { id: number; username?: string; first_name?: string }
        message?: { message_id: number; chat: { id: number; type: string } }
        data: string
    }
}async function handleUpdate(update: TelegramUpdate): Promise<void> {
    // Check for callback_query (inline buttons)
    if (update.callback_query) {
        const cb = update.callback_query
        const chatId = String(cb.message?.chat.id)
        const data = cb.data
        if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
            const isConfirm = data.startsWith('confirm_')
            const actionId = data.split('_')[1]
            if (!actionId) return
            const action = pendingActions.get(actionId)

            if (!action) {
                await sendMessage(chatId, '❌ This action has expired or was already handled.')
                return
            }
            pendingActions.delete(actionId)

            // Remove the inline keyboard (clean up)
            if (_botToken && cb.message) {
                await fetch(`${TELEGRAM_API}${_botToken}/editMessageReplyMarkup`, {
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
                await sendMessage(chatId, 'Action cancelled.')
                return
            }

            // Execute the action
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
                        },
                        priority: 2,
                    })

                    await sendMessage(chatId, `⏳ Queueing Task… _(${taskId.slice(0, 8)})_`)

                    const unsub = onAgentEvent((event) => {
                        if (event.taskId !== taskId) return
                        if (event.type === 'task_complete') {
                            unsub()
                            const result = (event.result as string | undefined) ?? 'Done.'
                            sendMessage(chatId, `✅ ${result}`).catch(() => null)
                            addToHistory(chatId, 'assistant', result)
                        } else if (event.type === 'task_failed' || event.type === 'task_blocked') {
                            unsub()
                            const reason = (event.reason as string | undefined) ?? 'Unknown error'
                            sendMessage(chatId, `❌ ${reason}`).catch(() => null)
                        }
                    })
                    setTimeout(() => unsub(), 5 * 60 * 1000)

                    emitToWorkspace(action.workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: action.description.slice(0, 200) })
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to queue Telegram task')
                    await sendMessage(chatId, '❌ Failed to queue task. Please try again.')
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
                    await sendMessage(chatId, `✅ Project created: _${sprint!.id}_. You can view it in the dashboard.`)
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to create Telegram project')
                    await sendMessage(chatId, '❌ Failed to create project. Please try again.')
                }
            }
            return
        }
    }

    // Regular text message

    const msg = update.message
    if (!msg?.text) return

    const chatId = String(msg.chat.id)
    const text = msg.text.trim()

    // /start — always welcome response
    if (text === '/start') {
        await sendMessage(chatId,
            '👋 Hi! I\'m *Plexo*, your AI agent.\n\n'
            + 'Tell me what you want done — I can research, write, build, automate, and more.\n\n'
            + 'Just describe the task in plain language.')
        return
    }

    const workspaceId = await resolveWorkspace(chatId)
    if (!workspaceId) {
        await sendMessage(chatId, '⚠️ This chat isn\'t linked to a Plexo workspace yet. Connect via Settings → Channels.')
        return
    }

    // Check if workspace has any AI provider configured
    const { credential } = await loadWorkspaceAISettings(workspaceId)
    if (!credential) {
        await sendMessage(chatId, '⚠️ No AI provider configured. Add your API key in Settings → AI Providers.')
        return
    }

    addToHistory(chatId, 'user', text)
    await sendTyping(chatId)
    const history = chatHistory.get(chatId) ?? []

    // Classify: is this a task or just conversation?
    const intent = await classifyIntent(workspaceId, history)


    if (intent === 'CONVERSATION') {
        const result = await chatWithAI(
            workspaceId,
            history,
            'You are Plexo, a helpful AI agent. Keep replies concise and friendly. '
            + 'If the user proposes a single distinct action, tell them you can execute it as a task and ask for confirmation. '
            + 'If the user proposes a large conceptual goal, tell them you can create a Project for it and ask for confirmation. '
            + 'If they ask for troubleshooting, help, or advice, ask clarifying questions first and do not rush to create tasks. '
            + 'Only agree to start a task or project when the scope is clear.'
        )
        // Log internal errors server-side; expose only neutral message to user
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
        addToHistory(chatId, 'assistant', replyText)
        await sendMessage(chatId, replyText)
        return
    }

    // TASK or PROJECT: Send inline keyboard
    const actionId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    pendingActions.set(actionId, {
        workspaceId,
        intent,
        description: text,
        from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
        messageId: msg.message_id
    })

    const replyText = `Ready to create a **${intent === 'TASK' ? 'Task' : 'Project'}**.\n\nDescription: _${text.slice(0, 100)}${text.length > 100 ? '...' : ''}_\n\nProceed?`

    // Log the query as a conversation interaction so it's not lost if the user cancels
    try {
        const taskId = await pushTask({
            workspaceId,
            type: 'online',
            source: 'telegram',
            status: 'complete',
            context: {
                description: text,
                channel: 'telegram',
                chatId,
                from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
                messageId: msg.message_id,
            },
            priority: 2,
        })
        await completeTask(taskId, {
            qualityScore: 1,
            outcomeSummary: replyText,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
        })
        emitToWorkspace(workspaceId, { type: 'task_complete', taskId, source: 'telegram' })
    } catch (err) {
        logger.error({ err, chatId }, 'Failed to log Telegram interaction to DB')
    }

    if (_botToken) {
        await fetch(`${TELEGRAM_API}${_botToken}/sendMessage`, {
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

}

// ── Webhook handler (production) ─────────────────────────────────────────────

telegramRouter.post('/webhook', async (req: Request, res: Response) => {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (_webhookSecret && secret !== _webhookSecret) {
        logger.warn('Telegram webhook secret mismatch')
        res.status(403).json({ error: 'Forbidden' })
        return
    }
    res.json({ ok: true })
    await handleUpdate(req.body as TelegramUpdate)
})

// ── GET /api/channels/telegram/info ─────────────────────────────────────────

telegramRouter.get('/info', (_req, res) => {
    res.json({
        configured: !!_botToken,
        webhookSecret: !!_webhookSecret,
        registeredChats: CHAT_TO_WORKSPACE.size,
        mode: process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes('localhost') ? 'webhook' : 'polling',
    })
})

// ── Long polling (local dev) ─────────────────────────────────────────────────

let _pollingActive = false

async function startLongPolling(token: string): Promise<void> {
    if (_pollingActive) return
    _pollingActive = true
    await deleteWebhook()
    logger.info('Telegram long polling started (local dev mode)')

    let offset = 0
    while (_pollingActive) {
        try {
            const res = await fetch(
                `${TELEGRAM_API}${token}/getUpdates?timeout=25&offset=${offset}`,
                { signal: AbortSignal.timeout(30_000) }
            )
            if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
            if (!data.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            for (const update of data.result) {
                offset = update.update_id + 1
                handleUpdate(update).catch(err => logger.warn({ err }, 'Telegram update handler failed'))
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

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initTelegramWebhook(): Promise<void> {
    const envToken = process.env.TELEGRAM_BOT_TOKEN
    if (envToken) {
        _botToken = envToken
    } else {
        try {
            const [ch] = await db.select({ config: channels.config })
                .from(channels).where(eq(channels.type, 'telegram')).limit(1)
            const config = ch?.config as { token?: string; bot_token?: string } | null
            _botToken = config?.token ?? config?.bot_token ?? null
        } catch { /* non-fatal */ }
    }

    if (!_botToken) {
        logger.info('No Telegram bot token found — Telegram adapter disabled')
        return
    }

    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? null

    const publicUrl = process.env.PUBLIC_URL
    if (publicUrl && !publicUrl.includes('localhost')) {
        const secret = _webhookSecret ?? 'plexo-telegram-prod'
        _webhookSecret = secret
        await setWebhook(`${publicUrl}/api/channels/telegram/webhook`, secret)
    } else {
        startLongPolling(_botToken).catch(err => logger.error({ err }, 'Telegram polling crashed'))
    }
}
